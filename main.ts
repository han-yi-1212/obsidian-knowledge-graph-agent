import { Plugin, WorkspaceLeaf, TFile, MarkdownView, Notice } from 'obsidian';
import { KnowledgeGraphView, GRAPH_VIEW_TYPE } from './src/graph-view';
import { ChatView, CHAT_VIEW_TYPE } from './src/chat-view';
import { KnowledgeGraphAgentSettingTab } from './src/settings';
import { DeepSeekAPI } from './src/api';
import { RAGEngine } from './src/rag';
import type { KnowledgeGraphAgentSettings, ChatMessage, ConversationContext } from './src/types';
import { DEFAULT_SETTINGS } from './src/types';

export default class KnowledgeGraphAgentPlugin extends Plugin {
  settings!: KnowledgeGraphAgentSettings;
  private lastSavedSettings!: KnowledgeGraphAgentSettings;
  deepseekAPI!: DeepSeekAPI;
  ragEngine!: RAGEngine;

  graphView: KnowledgeGraphView | null = null;
  chatView: ChatView | null = null;

  chatHistory: ChatMessage[] = [];
  conversationContext: ConversationContext = {
    activeNotePath: null,
    selectedNotes: [],
    searchResults: [],
  };

  async onload(): Promise<void> {
    await this.loadSettings();

    // Init API client and RAG engine
    this.deepseekAPI = new DeepSeekAPI(this.settings);
    this.ragEngine = new RAGEngine(
      this.app,
      this.settings.chunkSize,
      this.settings.chunkOverlap,
    );

    // Build initial RAG index
    this.ragEngine.rebuildIndex().then(() => {
      console.log(`KGA: RAG index built with ${this.ragEngine.indexSize} chunks`);
    });

    // ── Register views ──
    this.registerView(
      GRAPH_VIEW_TYPE,
      (leaf) => {
        this.graphView = new KnowledgeGraphView(leaf, this);
        return this.graphView;
      },
    );

    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => {
        this.chatView = new ChatView(leaf, this);
        return this.chatView;
      },
    );

    // ── Settings ──
    this.addSettingTab(new KnowledgeGraphAgentSettingTab(this.app, this));

    // ── Ribbon icon ──
    this.addRibbonIcon('dot-network', 'Open Knowledge Graph Agent', () => {
      this.activateView();
    });

    // ── Command: open the combined view ──
    this.addCommand({
      id: 'open-knowledge-graph-agent',
      name: 'Open Knowledge Graph Agent',
      callback: () => this.activateView(),
    });

    // ── Command: add current note to chat context ──
    this.addCommand({
      id: 'add-current-note-to-context',
      name: 'Add current note to chat context',
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.addNoteToContext(activeFile.path);
        }
      },
    });

    this.addCommand({
      id: 'clear-chat-context',
      name: 'Clear chat context',
      callback: () => {
        this.conversationContext.selectedNotes = [];
        this.chatView?.updateContextBadge();
      },
    });

    // ── Command: save last AI response to note ──
    this.addCommand({
      id: 'save-last-ai-response',
      name: 'Save last AI response to note',
      callback: async () => {
        const lastAssistant = [...this.chatHistory].reverse().find(
          m => m.role === 'assistant' && m.content && !m.content.startsWith('❌') && !m.content.startsWith('⏹️'),
        );
        if (!lastAssistant) {
          new Notice('No AI response to save.');
          return;
        }
        const lastUser = [...this.chatHistory].reverse().find(m => m.role === 'user');
        const question = lastUser?.content ?? 'Unknown question';
        if (this.chatView) {
          await this.chatView.saveResponseToNote(
            question,
            lastAssistant.content,
            lastAssistant.sources,
          );
        }
      },
    });

    // ── File change watchers (keep RAG index in sync) ──
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.ragEngine.indexFile(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.ragEngine.indexFile(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.ragEngine.removeFile(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.ragEngine.renameFile(oldPath, file.path, file.basename);
        }
      }),
    );

    // Track active note changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.conversationContext.activeNotePath = view?.file?.path ?? null;

        // Notify graph view to highlight the active note in the graph
        if (view?.file) {
          this.graphView?.highlightSearch();
        }

        this.chatView?.updateContextBadge();
      }),
    );
  }

  onunload(): void {
    // Plugin cleanup handled by Obsidian
  }

  // ── Public helpers ──

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.lastSavedSettings = { ...this.settings };
  }

  async saveSettings(): Promise<void> {
    // Compare against last persisted snapshot BEFORE saveData
    // (settings.ts onChange mutates this.settings FIRST, then calls us,
    //  so this.settings already carries the new values at this point)
    const chunkChanged =
      this.lastSavedSettings.chunkSize !== this.settings.chunkSize ||
      this.lastSavedSettings.chunkOverlap !== this.settings.chunkOverlap;

    await this.saveData(this.settings);

    // Always update the API client (key, model, temperature, etc.)
    this.deepseekAPI?.updateSettings(this.settings);

    if (chunkChanged) {
      this.ragEngine.updateChunkSettings(
        this.settings.chunkSize,
        this.settings.chunkOverlap,
      );
    }

    // Update snapshot to current persisted state
    this.lastSavedSettings = { ...this.settings };
  }

  addNoteToContext(path: string): void {
    if (!this.conversationContext.selectedNotes.includes(path)) {
      this.conversationContext.selectedNotes.push(path);
      this.chatView?.updateContextBadge();
    }
  }

  removeNoteFromContext(path: string): void {
    this.conversationContext.selectedNotes = this.conversationContext.selectedNotes.filter(
      p => p !== path,
    );
    this.chatView?.updateContextBadge();
  }

  getActiveNoteTitle(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file?.basename ?? null;
  }

  onGraphNodeSelected(path: string | null): void {
    if (path) {
      this.conversationContext.activeNotePath = path;
    }
    this.chatView?.updateContextBadge();
  }

  // ── Private ──

  private async activateView(): Promise<void> {
    const { workspace } = this.app;

    // Check if our leaf already exists
    const existing = workspace.getLeavesOfType(GRAPH_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    // Create the graph view in the main area
    const graphLeaf = workspace.getLeaf('split', 'vertical');
    await graphLeaf.setViewState({
      type: GRAPH_VIEW_TYPE,
      active: true,
    });

    // Create the chat view in the right sidebar
    const rightLeaf = workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({
        type: CHAT_VIEW_TYPE,
        active: true,
      });

      // Resize the right sidebar to roughly 1/3 width
      const rightSplit = rightLeaf.view.containerEl.closest('.workspace-split.mod-vertical');
      if (rightSplit) {
        // Let CSS handle the split ratio via our custom class
        rightLeaf.view.containerEl.addClass('kga-chat-sidebar');
      }
    }

    workspace.revealLeaf(graphLeaf);
  }
}
