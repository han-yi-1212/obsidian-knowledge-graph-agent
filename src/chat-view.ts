import { ItemView, WorkspaceLeaf, TFile, Notice, MarkdownRenderer } from 'obsidian';
import type KnowledgeGraphAgentPlugin from '../main';
import type { ChatMessage, IndexState, SearchResult } from './types';
import { apiErrorMessage, API_ERROR_CODES } from './api';

export const CHAT_VIEW_TYPE = 'knowledge-graph-agent-chat';

export class ChatView extends ItemView {
  private plugin: KnowledgeGraphAgentPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private contextBadge: HTMLElement | null = null;
  private bottomInfoEl: HTMLElement | null = null;
  private isStreaming = false;
  private abortController: AbortController | null = null;
  private unsubStatus: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KnowledgeGraphAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'AI Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('kga-chat-root');

    // ── Context badge ──
    this.contextBadge = root.createDiv('kga-chat-context');
    this.updateContextBadge();

    // ── Messages area ──
    this.messagesEl = root.createDiv('kga-chat-messages');

    // Delegate wikilink clicks → open the note
    this.messagesEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('kga-wikilink')) {
        const noteName = target.getAttribute('data-note');
        if (noteName) {
          this.openNoteByName(noteName);
        }
      }
    });

    // Welcome message
    await this.addMessage('assistant', '你好！我是你的知识图谱智能助手。\n\n- 在左侧图谱中 **双击节点** 打开笔记\n- **右键节点** 可以将笔记添加到对话上下文\n- 直接问我问题，我会检索相关笔记来回答\n- 我引用笔记时会使用 [[笔记名]] 格式');

    // ── Input area ──
    const inputArea = root.createDiv('kga-chat-input-area');

    this.inputEl = inputArea.createEl('textarea', {
      cls: 'kga-chat-input',
      placeholder: 'Ask about your knowledge graph...',
    });

    // Resize textarea as content grows
    this.inputEl.addEventListener('input', () => {
      const el = this.inputEl!;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.isStreaming) {
          this.stopStreaming();
        } else {
          this.sendMessage();
        }
      }
    });

    // Send button
    this.sendBtn = inputArea.createEl('button', {
      text: 'Send',
      cls: 'kga-chat-send-btn',
    });
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // Stop button (hidden by default, shown during streaming)
    this.stopBtn = inputArea.createEl('button', {
      text: 'Stop',
      cls: 'kga-chat-stop-btn',
    });
    this.stopBtn.addEventListener('click', () => this.stopStreaming());
    this.stopBtn.style.display = 'none';

    // ── Bottom bar ──
    const bottom = root.createDiv('kga-chat-bottom');
    this.bottomInfoEl = bottom.createEl('span', {
      text: `Model: ${this.plugin.settings.chatModel}`,
      cls: 'kga-chat-model-info',
    });

    const clearBtn = bottom.createEl('button', {
      text: 'Clear chat',
      cls: 'kga-chat-clear-btn',
    });
    clearBtn.addEventListener('click', () => this.clearChat());

    // ── Subscribe to index status (after input/bottom are created so
    //     the initial callback can disable them if index is still building)
    this.unsubStatus = this.plugin.ragEngine.onStatusChange((state: IndexState) => {
      this.updateIndexStatus(state);
    });
    this.updateIndexStatus(this.plugin.ragEngine.getState());
  }

  async onClose(): Promise<void> {
    this.unsubStatus?.();
    this.unsubStatus = null;
  }

  // ── Public API ──

  /** Update the context badge showing currently selected notes. */
  updateContextBadge(): void {
    if (!this.contextBadge) return;
    const ctx = this.plugin.conversationContext;

    this.contextBadge.empty();

    if (ctx.activeNotePath) {
      const f = this.app.vault.getAbstractFileByPath(ctx.activeNotePath);
      if (f) {
        this.contextBadge.createSpan({
          text: `📄 Active: ${f.name}`,
          cls: 'kga-context-chip kga-context-active',
        });
      }
    }

    for (const path of ctx.selectedNotes) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f) {
        const chip = this.contextBadge.createSpan({
          text: `📌 ${f.name}`,
          cls: 'kga-context-chip kga-context-selected',
        });
        chip.addEventListener('click', () => {
          this.plugin.removeNoteFromContext(path);
          this.updateContextBadge();
        });
        chip.setAttr('title', 'Click to remove from context');
      }
    }

    if (!ctx.activeNotePath && ctx.selectedNotes.length === 0) {
      this.contextBadge.createSpan({
        text: 'No notes in context — I\'ll search your vault',
        cls: 'kga-context-hint',
      });
    }
  }

  // ── Private ──

  private async sendMessage(): Promise<void> {
    if (this.isStreaming) return;

    const text = this.inputEl?.value.trim();
    if (!text) return;

    this.inputEl!.value = '';
    this.inputEl!.style.height = 'auto';

    await this.addMessage('user', text);

    const loadingEl = this.addLoadingMessage();
    this.setStreamingState(true);

    try {
      // 1. Search for relevant context
      const searchResults = this.plugin.ragEngine.search(text, this.plugin.settings.maxContextChunks);

      // Highlight relevant nodes in the graph
      this.plugin.graphView?.highlightRelevant(searchResults);

      // 1b. Read full content of user-selected context notes
      const selectedNotesContent: { title: string; content: string }[] = [];
      const selectedSources: SearchResult[] = [];
      for (const path of this.plugin.conversationContext.selectedNotes) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          try {
            const content = await this.app.vault.read(file);
            selectedNotesContent.push({
              title: file.basename,
              content: content.slice(0, 2000),
            });
            selectedSources.push({
              path: file.path,
              title: file.basename,
              chunk: content.slice(0, 200),
              score: 0,
              sourceType: 'pinned',
            });
          } catch {
            // skip unreadable files
          }
        }
      }

      // 2. Build messages array
      const systemPrompt = this.plugin.deepseekAPI.buildSystemPrompt(
        searchResults,
        this.plugin.getActiveNoteTitle(),
        selectedNotesContent.length > 0 ? selectedNotesContent : undefined,
      );

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...this.plugin.chatHistory,
        { role: 'user', content: text },
      ];

      // 3. Stream response with abort support
      let streamContent = '';
      let messageEl: HTMLElement | null = null;
      let messageWrapper: HTMLElement | null = null;
      let loadingRemoved = false;

      this.abortController = new AbortController();

      await this.plugin.deepseekAPI.chatStream(
        messages,
        (token) => {
          if (!loadingRemoved && loadingEl) {
            loadingEl.remove();
            loadingRemoved = true;
          }
          if (!messageEl) {
            const container = this.createMessageWrapper('assistant');
            messageEl = container.body;
            messageWrapper = container.wrapper;
          }
          streamContent += token;
          const rendered = this.renderMarkdownInline(streamContent);
          messageEl.empty();
          messageEl.appendChild(rendered);
          this.scrollToBottom();
        },
        async (fullText) => {
          // Ensure loading indicator is removed even on early abort
          if (!loadingRemoved && loadingEl) {
            loadingEl.remove();
            loadingRemoved = true;
          }

          if (fullText) {
            // Re-render final message with full Obsidian MarkdownRenderer
            if (messageEl) {
              messageEl.empty();
              await this.renderWithObsidian(fullText, messageEl);
            }

            // Merge pinned notes (first) with automatic search results
            const allSources = [...selectedSources, ...searchResults.filter(
              sr => !selectedSources.some(ss => ss.path === sr.path),
            )];

            // Render source citations below the message
            if (allSources.length > 0 && messageWrapper) {
              this.renderSources(messageWrapper, allSources);
              this.scrollToBottom();
            }

            this.plugin.chatHistory.push({ role: 'user', content: text });
            this.plugin.chatHistory.push({ role: 'assistant', content: fullText, sources: allSources });

            if (this.plugin.chatHistory.length > 40) {
              this.plugin.chatHistory = this.plugin.chatHistory.slice(-40);
            }
          } else {
            // Aborted before any tokens — remove the empty message wrapper and user message
            if (messageWrapper) {
              messageWrapper.remove();
            }
            // Show a brief hint that streaming was stopped
            this.addMessage('assistant', '⏹️ Stopped');
          }
        },
        (err, code) => {
          if (loadingEl) loadingEl.remove();
          const friendlyMsg = code ? apiErrorMessage(code) : err.message;
          new Notice(friendlyMsg);
          this.addMessage('assistant', `❌ ${friendlyMsg}`);
        },
        this.abortController.signal,
      );
    } catch (err) {
      if (loadingEl) loadingEl.remove();
      const msg = err instanceof Error ? err.message : String(err);
      this.addMessage('assistant', `❌ Error: ${msg}`);
    } finally {
      this.abortController = null;
      this.setStreamingState(false);
      this.updateIndexStatus(this.plugin.ragEngine.getState());
      this.inputEl?.focus();
    }
  }

  private stopStreaming(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Toggle between streaming and idle UI state. */
  private setStreamingState(streaming: boolean): void {
    this.isStreaming = streaming;
    // Keep textarea enabled so Enter-to-stop works
    if (this.inputEl) {
      this.inputEl.readOnly = streaming;
      if (streaming) {
        this.inputEl.setAttr('placeholder', 'Streaming… press Enter to stop');
      } else {
        this.inputEl.setAttr('placeholder', 'Ask about your knowledge graph...');
      }
    }
    if (this.sendBtn) {
      this.sendBtn.style.display = streaming ? 'none' : '';
    }
    if (this.stopBtn) {
      this.stopBtn.style.display = streaming ? '' : 'none';
    }
  }

  private async addMessage(role: 'user' | 'assistant', content: string): Promise<HTMLElement> {
    const { body } = this.createMessageWrapper(role);
    await this.renderWithObsidian(content, body);
    this.scrollToBottom();
    return body;
  }

  /** Creates a message DOM structure, returning both wrapper and body. */
  private createMessageWrapper(role: 'user' | 'assistant'): { wrapper: HTMLElement; body: HTMLElement } {
    if (!this.messagesEl) throw new Error('Messages container not initialized');

    const wrapper = this.messagesEl.createDiv(`kga-message kga-message-${role}`);
    const avatar = wrapper.createDiv('kga-message-avatar');
    avatar.setText(role === 'user' ? 'U' : 'AI');

    const body = wrapper.createDiv('kga-message-body');
    return { wrapper, body };
  }

  private addLoadingMessage(): HTMLElement {
    if (!this.messagesEl) throw new Error('Messages container not initialized');

    const wrapper = this.messagesEl.createDiv('kga-message kga-message-assistant');
    const avatar = wrapper.createDiv('kga-message-avatar');
    avatar.setText('AI');

    const body = wrapper.createDiv('kga-message-body');
    body.createSpan({ text: 'Thinking...', cls: 'kga-loading' });
    this.scrollToBottom();
    return body;
  }

  /**
   * Render a collapsible "Sources (N)" section below an AI message.
   * Sources are grouped: Pinned first, then Retrieved with scores.
   */
  private renderSources(wrapper: HTMLElement, sources: SearchResult[]): void {
    const container = wrapper.createDiv('kga-sources');

    const pinnedSources = sources.filter(s => s.sourceType === 'pinned');
    const retrievedSources = sources.filter(s => s.sourceType !== 'pinned');

    // Summary bar
    const summary = container.createDiv('kga-sources-summary');
    const parts: string[] = [];
    if (pinnedSources.length > 0) parts.push(`${pinnedSources.length} Pinned`);
    if (retrievedSources.length > 0) parts.push(`${retrievedSources.length} Retrieved`);
    summary.createSpan({ text: `📚 Sources: ${parts.join(' + ')}` });
    summary.addEventListener('click', () => {
      container.classList.toggle('kga-sources-open');
    });

    // Normalize retrieved scores
    const retrievedScores = retrievedSources.map(s => s.score);
    const maxScore = Math.max(...retrievedScores, 0.01);

    // Detail list
    const list = container.createDiv('kga-sources-list');

    // Pinned section
    if (pinnedSources.length > 0) {
      const pinnedHeader = list.createDiv('kga-sources-section-header');
      pinnedHeader.createSpan({ text: '📌 Pinned Notes', cls: 'kga-sources-section-label' });
      pinnedHeader.createSpan({ text: `Manually added — highest priority`, cls: 'kga-sources-section-hint' });

      for (const source of pinnedSources) {
        this.renderSourceItem(list, source, '📌 Pinned', 'kga-source-pinned');
      }
    }

    // Retrieved section
    if (retrievedSources.length > 0) {
      const retrievedHeader = list.createDiv('kga-sources-section-header');
      retrievedHeader.createSpan({ text: '🔍 Retrieved Notes', cls: 'kga-sources-section-label' });
      retrievedHeader.createSpan({ text: `Auto-matched from your vault`, cls: 'kga-sources-section-hint' });

      for (const source of retrievedSources) {
        const normalized = source.score / maxScore;
        this.renderSourceItem(list, source, `${Math.round(normalized * 100)}%`, '');
      }
    }
  }

  private renderSourceItem(
    list: HTMLElement,
    source: SearchResult,
    label: string,
    labelClass: string,
  ): void {
    const item = list.createDiv('kga-source-item');

    const header = item.createDiv('kga-source-header');
    const nameEl = header.createSpan({
      text: source.title,
      cls: 'kga-wikilink',
    });
    nameEl.setAttribute('data-note', source.title);
    header.createSpan({
      text: label,
      cls: `kga-source-score ${labelClass}`,
    });

    const snippet = item.createDiv('kga-source-snippet');
    snippet.setText(source.chunk.slice(0, 200) + (source.chunk.length > 200 ? '…' : ''));
  }

  /**
   * Lightweight streaming-safe markdown → HTML.
   */
  private renderMarkdownInline(text: string): HTMLElement {
    const container = createSpan();

    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Wikilinks: [[note name]] → clickable span with data-note attribute
    html = html.replace(
      /\[\[([^\]]+)\]\]/g,
      '<span class="kga-wikilink" data-note="$1">🔗 $1</span>',
    );

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    container.innerHTML = html;
    return container;
  }

  /**
   * Re-render markdown with Obsidian's full MarkdownRenderer (async).
   */
  private async renderWithObsidian(markdown: string, container: HTMLElement): Promise<void> {
    await MarkdownRenderer.render(
      this.app,
      markdown,
      container,
      '',
      this,
    );

    // Re-wrap wikilinks produced by Obsidian's renderer with our clickable span
    container.querySelectorAll('a.internal-link').forEach((a) => {
      const noteName = a.getAttribute('data-href') ?? a.textContent ?? '';
      a.classList.add('kga-wikilink');
      a.setAttribute('data-note', noteName.replace(/\.md$/, ''));
    });
  }

  private openNoteByName(name: string): void {
    const cleanName = name.replace(/\.md$/, '');
    const file = this.app.metadataCache.getFirstLinkpathDest(cleanName, '');
    if (file instanceof TFile) {
      this.app.workspace.openLinkText(file.path, '', false);
    } else {
      new Notice(`Note not found: ${cleanName}`);
    }
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    requestAnimationFrame(() => {
      this.messagesEl!.scrollTop = this.messagesEl!.scrollHeight;
    });
  }

  private updateIndexStatus(state: IndexState): void {
    if (this.contextBadge) {
      const existing = this.contextBadge.querySelector('.kga-context-indexing, .kga-context-error');
      existing?.remove();

      if (state.status === 'indexing') {
        const chip = this.contextBadge.createSpan({
          text: `🔄 ${state.message}`,
          cls: 'kga-context-chip kga-context-indexing',
        });
        chip.style.animation = 'kga-pulse 1.5s ease-in-out infinite';
      } else if (state.status === 'error') {
        this.contextBadge.createSpan({
          text: `⚠️ ${state.message}`,
          cls: 'kga-context-chip kga-context-error',
        });
      }
    }

    if (this.bottomInfoEl) {
      const parts = [`Model: ${this.plugin.settings.chatModel}`];
      if (state.status === 'ready') {
        parts.push(`Index: ${state.chunkCount} chunks`);
      }
      this.bottomInfoEl.setText(parts.join(' · '));
    }

    // Respect streaming state — don't re-enable input mid-stream
    if (state.status === 'indexing' || state.status === 'idle') {
      if (!this.isStreaming) {
        this.setInputEnabled(false);
        if (this.inputEl) {
          this.inputEl.placeholder = 'Building knowledge index…';
        }
      }
    } else if (!this.isStreaming) {
      this.setInputEnabled(true);
      if (this.inputEl) {
        this.inputEl.placeholder = 'Ask about your knowledge graph...';
      }
    }
  }

  private setInputEnabled(enabled: boolean): void {
    if (this.inputEl) {
      this.inputEl.disabled = !enabled;
    }
    if (this.sendBtn) {
      this.sendBtn.disabled = !enabled;
      this.sendBtn.textContent = enabled ? 'Send' : '...';
    }
  }

  clearChat(): void {
    this.stopStreaming();
    this.plugin.chatHistory = [];
    if (this.messagesEl) {
      this.messagesEl.empty();
      this.addMessage('assistant', 'Chat cleared. How can I help you?');
    }
  }
}
