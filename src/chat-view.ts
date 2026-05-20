import { ItemView, WorkspaceLeaf, TFile, Notice, MarkdownRenderer, MarkdownView } from 'obsidian';
import type KnowledgeGraphAgentPlugin from '../main';
import type { ChatMessage, IndexState, SearchResult } from './types';
import { apiErrorMessage, API_ERROR_CODES } from './api';
import { DraftPreviewModal } from './draft-preview-modal';
import {
  parseDraftsFromResponse,
  sanitizeDrafts,
  validateDrafts,
  checkConflicts,
  createNotesFromDrafts,
  summarizeResults,
  MAX_DRAFTS,
} from './note-drafts';

export const CHAT_VIEW_TYPE = 'knowledge-graph-agent-chat';

function slugify(text: string, maxLen = 50): string {
  return text
    .replace(/[\s\n\r]+/g, ' ')
    .replace(/[\\/:*?"<>|#^\[\]{}]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLen)
    .trim()
    .replace(/\.+$/, '')
    || 'AI Response';
}

function formatResponseBlock(
  question: string,
  response: string,
  sources?: SearchResult[],
): string {
  let block = `\n\n---\n\n## 💬 AI Response re: "${slugify(question, 60)}"\n\n${response}\n`;

  if (sources && sources.length > 0) {
    block += `\n> [!note]- Sources\n`;
    for (const s of sources) {
      const label = s.sourceType === 'pinned' ? 'Pinned' : 'Retrieved';
      block += `> - [[${s.title}]] (${label})\n`;
    }
  }

  block += '\n---\n\n';
  return block;
}

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
  private isDraftMode = false;
  private draftToggleBtn: HTMLButtonElement | null = null;

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

    // Draft mode toggle
    this.draftToggleBtn = inputArea.createEl('button', {
      text: '📝',
      cls: 'kga-draft-toggle-btn',
    });
    this.draftToggleBtn.setAttr('title', 'Draft notes mode — AI generates structured note drafts for review');
    this.draftToggleBtn.addEventListener('click', () => {
      this.setDraftMode(!this.isDraftMode);
    });

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

      // 3. Branch: draft mode (non-streaming JSON) vs normal (streaming)
      if (this.isDraftMode) {
        // ── Draft mode: non-streaming JSON response ──
        if (loadingEl) {
          loadingEl.empty();
          loadingEl.createSpan({ text: 'Generating drafts...', cls: 'kga-loading' });
        }

        const draftSystemPrompt = this.plugin.deepseekAPI.buildDraftSystemPrompt(
          searchResults,
          this.plugin.getActiveNoteTitle(),
          selectedNotesContent.length > 0 ? selectedNotesContent : undefined,
        );

        const draftMessages: ChatMessage[] = [
          { role: 'system', content: draftSystemPrompt },
          ...this.plugin.chatHistory,
          { role: 'user', content: text },
        ];

        try {
          const response = await this.plugin.deepseekAPI.chat(draftMessages);

          if (loadingEl) loadingEl.remove();

          const rawDrafts = parseDraftsFromResponse(response);

          if (rawDrafts && rawDrafts.length > 0) {
            // Truncate and sanitize
            const totalFromAI = rawDrafts.length;
            const truncated = rawDrafts.slice(0, MAX_DRAFTS);
            const { cleaned: drafts, warnings } = sanitizeDrafts(truncated);
            const errors = validateDrafts(drafts);

            if (errors.length === 0) {
              const conflicts = checkConflicts(drafts, this.app);

              const handleConfirm = async (selected: typeof drafts) => {
                const results = await createNotesFromDrafts(
                  selected,
                  this.app,
                  this.plugin.ragEngine,
                );
                const summary = summarizeResults(results);
                await this.addMessage('assistant', summary);
                this.plugin.chatHistory.push({ role: 'user', content: text });
                this.plugin.chatHistory.push({ role: 'assistant', content: summary });

                if (this.plugin.chatHistory.length > 40) {
                  this.plugin.chatHistory = this.plugin.chatHistory.slice(-40);
                }
              };

              new DraftPreviewModal(this.app, drafts, conflicts, warnings, totalFromAI, handleConfirm).open();
            } else {
              const errorText = errors.map(e => `- ${e.message}`).join('\n');
              await this.addMessage('assistant', `⚠️ Draft validation issues:\n\n${errorText}\n\n<details><summary>Raw AI response</summary>\n\n${response}\n</details>`);
              this.plugin.chatHistory.push({ role: 'user', content: text });
              this.plugin.chatHistory.push({ role: 'assistant', content: response });

              if (this.plugin.chatHistory.length > 40) {
                this.plugin.chatHistory = this.plugin.chatHistory.slice(-40);
              }
            }
          } else {
            // JSON parse failed — show raw response as normal text
            await this.addMessage('assistant', response);
            this.plugin.chatHistory.push({ role: 'user', content: text });
            this.plugin.chatHistory.push({ role: 'assistant', content: response });

            if (this.plugin.chatHistory.length > 40) {
              this.plugin.chatHistory = this.plugin.chatHistory.slice(-40);
            }
          }
        } catch (err: any) {
          if (loadingEl) loadingEl.remove();
          const code = err?.code;
          const friendlyMsg = code ? apiErrorMessage(code) : (err instanceof Error ? err.message : String(err));
          this.addMessage('assistant', `❌ ${friendlyMsg}`);
        }

        this.setDraftMode(false);
      } else {
        // ── Normal mode: streaming response ──
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
            }

            // Action buttons row
            if (messageWrapper) {
              const actions = messageWrapper.createDiv('kga-message-actions');

              const saveBtn = actions.createEl('button', {
                text: '💾 Save to note',
                cls: 'kga-save-note-btn',
              });
              saveBtn.addEventListener('click', async () => {
                saveBtn.disabled = true;
                saveBtn.setText('✅ Saved');
                await this.saveResponseToNote(text, fullText, allSources);
              });

              const insertBtn = actions.createEl('button', {
                text: '↩ Insert into active note',
                cls: 'kga-save-note-btn',
              });
              insertBtn.addEventListener('click', () => {
                this.insertIntoActiveNote(text, fullText, allSources);
              });

              const appendBtn = actions.createEl('button', {
                text: '📎 Append to active note',
                cls: 'kga-save-note-btn',
              });
              appendBtn.addEventListener('click', () => {
                this.appendToActiveNote(text, fullText, allSources);
              });
            }

            this.scrollToBottom();

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
      } // end else (normal streaming mode)
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

  private setDraftMode(on: boolean): void {
    this.isDraftMode = on;
    if (this.draftToggleBtn) {
      if (on) {
        this.draftToggleBtn.addClass('kga-draft-toggle-active');
      } else {
        this.draftToggleBtn.removeClass('kga-draft-toggle-active');
      }
    }
    if (this.inputEl) {
      if (on) {
        this.inputEl.setAttr('placeholder', 'Describe the notes you want to draft…');
      } else {
        this.inputEl.setAttr('placeholder', 'Ask about your knowledge graph...');
      }
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

  async saveResponseToNote(
    question: string,
    response: string,
    sources?: SearchResult[],
  ): Promise<void> {
    const dir = 'AI Responses/';
    const titleBase = slugify(question) || 'AI Response';

    let content = `# ${titleBase}\n\n`;
    content += `## Question\n\n${question}\n\n`;
    content += `## Response\n\n${response}\n\n`;

    if (sources && sources.length > 0) {
      content += `> [!note]- Sources\n`;
      for (const s of sources) {
        const label = s.sourceType === 'pinned' ? 'Pinned' : 'Retrieved';
        content += `> - [[${s.title}]] (${label})\n`;
      }
      content += '\n';
    }

    // Dedup: if titleBase.md exists, try "titleBase - 2.md", "titleBase - 3.md", …
    let fileName = titleBase;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${dir}${fileName}.md`)) {
      fileName = `${titleBase} - ${suffix}`;
      suffix++;
    }

    const filePath = `${dir}${fileName}.md`;
    const file = await this.app.vault.create(filePath, content);
    await this.app.workspace.openLinkText(file.path, '', false);
    new Notice(`Saved: ${file.path}`);
  }

  insertIntoActiveNote(
    question: string,
    response: string,
    sources?: SearchResult[],
  ): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      new Notice('No active note to insert into.');
      return;
    }
    const text = formatResponseBlock(question, response, sources);
    const cursor = activeView.editor.getCursor();
    activeView.editor.replaceRange(text, cursor);
    new Notice('Inserted AI response at cursor.');
  }

  appendToActiveNote(
    question: string,
    response: string,
    sources?: SearchResult[],
  ): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      new Notice('No active note to append to.');
      return;
    }
    const text = formatResponseBlock(question, response, sources);
    const editor = activeView.editor;
    const lastLine = editor.lastLine();
    editor.replaceRange(text, { line: lastLine, ch: editor.getLine(lastLine).length });
    new Notice('Appended AI response to note.');
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
