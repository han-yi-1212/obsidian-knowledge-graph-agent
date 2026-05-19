import { ItemView, WorkspaceLeaf, TFile, Notice, MarkdownRenderer } from 'obsidian';
import type KnowledgeGraphAgentPlugin from '../main';
import type { ChatMessage } from './types';

export const CHAT_VIEW_TYPE = 'knowledge-graph-agent-chat';

export class ChatView extends ItemView {
  private plugin: KnowledgeGraphAgentPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private contextBadge: HTMLElement | null = null;
  private isStreaming = false;

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
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl('button', {
      text: 'Send',
      cls: 'kga-chat-send-btn',
    });
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // ── Bottom bar ──
    const bottom = root.createDiv('kga-chat-bottom');
    bottom.createEl('span', {
      text: `Model: ${this.plugin.settings.chatModel}`,
      cls: 'kga-chat-model-info',
    });

    const clearBtn = bottom.createEl('button', {
      text: 'Clear chat',
      cls: 'kga-chat-clear-btn',
    });
    clearBtn.addEventListener('click', () => this.clearChat());
  }

  async onClose(): Promise<void> {
    // no-op
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
    this.setInputEnabled(false);
    this.isStreaming = true;

    try {
      // 1. Search for relevant context
      const searchResults = this.plugin.ragEngine.search(text, this.plugin.settings.maxContextChunks);

      // Highlight relevant nodes in the graph
      this.plugin.graphView?.highlightRelevant(searchResults);

      // 1b. Read full content of user-selected context notes
      const selectedNotesContent: { title: string; content: string }[] = [];
      for (const path of this.plugin.conversationContext.selectedNotes) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          try {
            const content = await this.app.vault.read(file);
            selectedNotesContent.push({
              title: file.basename,
              content: content.slice(0, 2000), // cap to avoid blowing context
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

      // 3. Stream response
      let streamContent = '';
      let messageEl: HTMLElement | null = null;
      let loadingRemoved = false;

      await this.plugin.deepseekAPI.chatStream(
        messages,
        (token) => {
          if (!loadingRemoved && loadingEl) {
            loadingEl.remove();
            loadingRemoved = true;
          }
          if (!messageEl) {
            messageEl = this.createMessageContainer('assistant');
          }
          streamContent += token;
          const rendered = this.renderMarkdownInline(streamContent);
          messageEl.empty();
          messageEl.appendChild(rendered);
          this.scrollToBottom();
        },
        async (fullText) => {
          // Re-render final message with full Obsidian MarkdownRenderer
          if (messageEl) {
            messageEl.empty();
            await this.renderWithObsidian(fullText, messageEl);
          }

          this.plugin.chatHistory.push({ role: 'user', content: text });
          this.plugin.chatHistory.push({ role: 'assistant', content: fullText });

          // Trim history to last 40 messages to avoid context overflow
          if (this.plugin.chatHistory.length > 40) {
            this.plugin.chatHistory = this.plugin.chatHistory.slice(-40);
          }
        },
        (err) => {
          if (loadingEl) loadingEl.remove();
          this.addMessage('assistant', `❌ Error: ${err.message}`);
        },
      );
    } catch (err) {
      if (loadingEl) loadingEl.remove();
      const msg = err instanceof Error ? err.message : String(err);
      this.addMessage('assistant', `❌ Error: ${msg}`);
    } finally {
      this.isStreaming = false;
      this.setInputEnabled(true);
      this.inputEl?.focus();
    }
  }

  private async addMessage(role: 'user' | 'assistant', content: string): Promise<HTMLElement> {
    const el = this.createMessageContainer(role);
    await this.renderWithObsidian(content, el);
    this.scrollToBottom();
    return el;
  }

  private createMessageContainer(role: 'user' | 'assistant'): HTMLElement {
    if (!this.messagesEl) throw new Error('Messages container not initialized');

    const wrapper = this.messagesEl.createDiv(`kga-message kga-message-${role}`);
    const avatar = wrapper.createDiv('kga-message-avatar');
    avatar.setText(role === 'user' ? 'U' : 'AI');

    const body = wrapper.createDiv('kga-message-body');
    return body;
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
   * Lightweight streaming-safe markdown → HTML.
   * Wikilinks rendered as clickable spans with data-note for event delegation.
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
    // Obsidian renders [[note]] as <a class="internal-link"> — we add data-note for delegation
    container.querySelectorAll('a.internal-link').forEach((a) => {
      const noteName = a.getAttribute('data-href') ?? a.textContent ?? '';
      a.classList.add('kga-wikilink');
      a.setAttribute('data-note', noteName.replace(/\.md$/, ''));
    });
  }

  /**
   * Try to find and open a note by its basename.
   */
  private openNoteByName(name: string): void {
    // Strip potential .md extension, then try to resolve
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
    this.plugin.chatHistory = [];
    if (this.messagesEl) {
      this.messagesEl.empty();
      this.addMessage('assistant', 'Chat cleared. How can I help you?');
    }
  }
}
