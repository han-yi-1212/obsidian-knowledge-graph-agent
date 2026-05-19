import { ItemView, WorkspaceLeaf, TFile, Menu, Notice } from 'obsidian';
import cytoscape, { Core } from 'cytoscape';
import type KnowledgeGraphAgentPlugin from '../main';
import type { GraphData, SearchResult } from './types';

export const GRAPH_VIEW_TYPE = 'knowledge-graph-agent-graph';

export class KnowledgeGraphView extends ItemView {
  private plugin: KnowledgeGraphAgentPlugin;
  private cy: Core | null = null;
  private container: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private graphData: GraphData = { nodes: [], edges: [] };
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KnowledgeGraphAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Knowledge Graph';
  }

  getIcon(): string {
    return 'dot-network';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('kga-graph-root');

    // ── Toolbar ──
    const toolbar = root.createDiv('kga-graph-toolbar');

    this.searchInput = toolbar.createEl('input', {
      type: 'text',
      placeholder: 'Search nodes...',
      cls: 'kga-graph-search',
    });

    let searchTimeout: ReturnType<typeof setTimeout>;
    this.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this.highlightSearch(), 200);
    });

    const refreshBtn = toolbar.createEl('button', {
      text: 'Refresh',
      cls: 'kga-graph-btn',
    });
    refreshBtn.addEventListener('click', () => this.refreshGraph());

    const fitBtn = toolbar.createEl('button', {
      text: 'Fit',
      cls: 'kga-graph-btn',
    });
    fitBtn.addEventListener('click', () => this.cy?.fit(undefined, 50));

    // ── Graph canvas ──
    this.container = root.createDiv('kga-graph-canvas');

    await this.refreshGraph();

    // ResizeObserver to keep Cytoscape sized correctly
    this.resizeObserver = new ResizeObserver(() => {
      this.cy?.resize();
    });
    this.resizeObserver.observe(this.container);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.cy?.destroy();
    this.cy = null;
  }

  // ── Public API ──

  /** Refresh graph data from the vault metadata cache. */
  async refreshGraph(): Promise<void> {
    if (!this.container) return;

    const metadataCache = this.app.metadataCache;
    const allFiles = this.app.vault.getMarkdownFiles();
    const settings = this.plugin.settings;
    const maxNodes = settings.graphMaxNodes;

    // ── Compute backlink counts from resolvedLinks ──
    // resolvedLinks: { [sourcePath]: { [targetPath]: count } }
    const backlinkCount = new Map<string, number>();
    const resolvedLinks = metadataCache.resolvedLinks;
    for (const sourcePath of Object.keys(resolvedLinks)) {
      const targets = resolvedLinks[sourcePath];
      for (const targetPath of Object.keys(targets)) {
        backlinkCount.set(targetPath, (backlinkCount.get(targetPath) ?? 0) + 1);
      }
    }

    // Build node map: out-degree + in-degree = total link weight
    const nodeMap = new Map<string, { title: string; links: number }>();
    for (const file of allFiles) {
      const cache = metadataCache.getFileCache(file);
      const outLinks = cache?.links?.length ?? 0;
      // Count unique incoming links (each source file that links here counts once)
      const inLinks = backlinkCount.get(file.path) ?? 0;
      nodeMap.set(file.path, {
        title: file.basename,
        links: outLinks + inLinks,
      });
    }

    // Sort by link count (descending), cap at maxNodes
    const sorted = [...nodeMap.entries()]
      .filter(([_, v]) => settings.graphShowOrphans || v.links > 0)
      .sort((a, b) => b[1].links - a[1].links);

    const topNodes = sorted.slice(0, maxNodes);
    const topPaths = new Set(topNodes.map(n => n[0]));

    // Build edge list from links within the top node set
    // Pre-build file map for O(1) lookup
    const fileMap = new Map<string, TFile>();
    for (const f of allFiles) fileMap.set(f.path, f);

    const edges: GraphData['edges'] = [];
    const seenEdges = new Set<string>();

    for (const [path] of topNodes) {
      const file = fileMap.get(path);
      if (!file) continue;
      const cache = metadataCache.getFileCache(file);
      if (!cache?.links) continue;

      for (const link of cache.links) {
        const resolved = metadataCache.getFirstLinkpathDest(link.link, file.path);
        if (!resolved) continue;
        if (!topPaths.has(resolved.path)) continue;

        const edgeId = [path, resolved.path].sort().join('||');
        if (!seenEdges.has(edgeId)) {
          seenEdges.add(edgeId);
          edges.push({
            id: edgeId,
            source: path,
            target: resolved.path,
          });
        }
      }
    }

    const nodes: GraphData['nodes'] = topNodes.map(([path, info]) => ({
      id: path,
      label: info.title,
      path,
      links: info.links,
    }));

    this.graphData = { nodes, edges };
    this.renderGraph();
  }

  /** Highlight nodes whose titles match the search query in the search input. */
  highlightSearch(): void {
    if (!this.cy) return;
    const query = this.searchInput?.value.trim().toLowerCase() ?? '';

    if (!query) {
      this.cy.elements().removeClass('kga-dimmed kga-highlighted');
      return;
    }

    const matchedIds = new Set<string>();
    for (const node of this.graphData.nodes) {
      if (node.label.toLowerCase().includes(query)) {
        matchedIds.add(node.id);
      }
    }

    this.cy.nodes().forEach(n => {
      if (matchedIds.has(n.id())) {
        n.removeClass('kga-dimmed').addClass('kga-highlighted');
      } else {
        n.removeClass('kga-highlighted').addClass('kga-dimmed');
      }
    });

    this.cy.edges().forEach(e => {
      const src = e.source().id();
      const tgt = e.target().id();
      if (matchedIds.has(src) && matchedIds.has(tgt)) {
        e.removeClass('kga-dimmed').addClass('kga-highlighted');
      } else {
        e.removeClass('kga-highlighted').addClass('kga-dimmed');
      }
    });
  }

  /** Apply relevance scores from RAG results — size/color nodes accordingly. */
  highlightRelevant(searchResults: SearchResult[]): void {
    if (!this.cy) return;

    const scores = new Map<string, number>();
    for (const r of searchResults) {
      scores.set(r.path, r.score);
    }

    // Normalize
    const maxScore = Math.max(...scores.values(), 1);

    this.cy.nodes().forEach(n => {
      const score = scores.get(n.id()) ?? 0;
      const normalized = score / maxScore;

      n.data('relevance', normalized);
      if (normalized > 0) {
        n.addClass('kga-relevant');
        n.css({
          'width': 20 + normalized * 40,
          'height': 20 + normalized * 40,
          'background-color': `rgba(59, 130, 246, ${0.3 + normalized * 0.7})`,
        });
      } else {
        n.removeClass('kga-relevant');
        n.css({ 'width': 16, 'height': 16, 'background-color': '' });
      }
    });
  }

  /** Fit the graph view to show all nodes. */
  fitGraph(): void {
    this.cy?.fit(undefined, 50);
  }

  // ── Private ──

  private renderGraph(): void {
    if (!this.container) return;
    this.cy?.destroy();

    const elements: cytoscape.ElementDefinition[] = [
      ...this.graphData.nodes.map(n => ({
        data: {
          id: n.id,
          label: n.label,
          links: n.links,
        },
        classes: 'kga-node',
      })),
      ...this.graphData.edges.map(e => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
        },
        classes: 'kga-edge',
      })),
    ];

    this.cy = cytoscape({
      container: this.container,
      elements,
      style: [
        {
          selector: '.kga-node',
          style: {
            'label': 'data(label)',
            'width': 16,
            'height': 16,
            'background-color': '#6366f1',
            'color': '#e0e0e0',
            'font-size': '10px',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-wrap': 'ellipsis',
            'text-max-width': '120px',
            'border-width': 1,
            'border-color': '#818cf8',
          },
        },
        {
          selector: '.kga-node.kga-highlighted',
          style: {
            'background-color': '#f59e0b',
            'border-color': '#fbbf24',
            'border-width': 2,
          },
        },
        {
          selector: '.kga-node.kga-dimmed',
          style: {
            'opacity': 0.2,
          },
        },
        {
          selector: '.kga-node.kga-relevant',
          style: {
            'border-color': '#3b82f6',
            'border-width': 2,
          },
        },
        {
          selector: '.kga-node:selected',
          style: {
            'border-color': '#ef4444',
            'border-width': 3,
          },
        },
        {
          selector: '.kga-edge',
          style: {
            'width': 0.5,
            'line-color': '#475569',
            'opacity': 0.4,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#475569',
            'arrow-scale': 0.6,
          },
        },
        {
          selector: '.kga-edge.kga-highlighted',
          style: {
            'width': 1.5,
            'line-color': '#f59e0b',
            'opacity': 0.8,
          },
        },
        {
          selector: '.kga-edge.kga-dimmed',
          style: {
            'opacity': 0.05,
          },
        },
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 800,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
        gravity: 0.3,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
      },
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    // ── Events ──

    this.cy.on('dbltap', 'node', (evt) => {
      const node = evt.target;
      const path = node.id();
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        this.app.workspace.openLinkText(file.path, '', false);
      }
    });

    this.cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      this.plugin.onGraphNodeSelected(node.id());
    });

    this.cy.on('cxttap', 'node', (evt) => {
      const node = evt.target;
      const path = node.id();
      const file = this.app.vault.getAbstractFileByPath(path);

      const menu = new Menu();
      menu.addItem(item => item
        .setTitle('Open note')
        .setIcon('file')
        .onClick(() => {
          if (file instanceof TFile) {
            this.app.workspace.openLinkText(file.path, '', false);
          }
        }));
      menu.addItem(item => item
        .setTitle('Open in new pane')
        .setIcon('split')
        .onClick(() => {
          if (file instanceof TFile) {
            this.app.workspace.openLinkText(file.path, '', 'split');
          }
        }));
      menu.addItem(item => item
        .setTitle('Add to chat context')
        .setIcon('message-square')
        .onClick(() => {
          this.plugin.addNoteToContext(path);
          new Notice(`Added "${node.data('label')}" to chat context`);
        }));
      menu.showAtPosition({ x: evt.originalEvent.clientX, y: evt.originalEvent.clientY });
    });

    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.plugin.onGraphNodeSelected(null);
      }
    });
  }
}
