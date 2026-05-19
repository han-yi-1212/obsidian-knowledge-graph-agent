import { App, TFile } from 'obsidian';
import type { SearchResult, IndexStatus, IndexState } from './types';
import {
  ChunkEntry,
  tokenize,
  chunkText,
  keywordSearch,
  rerank,
} from './retrieval';

type StatusCallback = (state: IndexState) => void;

/**
 * Two-stage keyword + rerank retrieval engine.
 *
 * Stage 1: TF-IDF keyword recall (broad, fast).
 * Stage 2: Rich-signal reranker (phrase matching, proximity, title weight).
 *
 * Pure retrieval functions live in ./retrieval.ts for testability.
 * This class owns the in-memory index, dfMap, and Obsidian vault I/O.
 */
export class RAGEngine {
  private app: App;
  private index: ChunkEntry[] = [];
  private dfMap: Map<string, number> = new Map();
  private chunkSize: number;
  private chunkOverlap: number;

  // ── lifecycle state ──
  private _status: IndexStatus = 'idle';
  private _indexingPromise: Promise<void> | null = null;
  private _pendingRebuild = false;
  private _dirtyPaths: Set<string> = new Set();
  private _callbacks: Set<StatusCallback> = new Set();

  constructor(app: App, chunkSize = 500, chunkOverlap = 50) {
    this.app = app;
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  get indexSize(): number {
    return this.index.length;
  }

  /** Whether the engine is currently indexing. */
  get isIndexing(): boolean {
    return this._status === 'indexing';
  }

  // ── public status API ──

  getState(): IndexState {
    return {
      status: this._status,
      message: this._buildMessage(),
      chunkCount: this.index.length,
    };
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(cb: StatusCallback): () => void {
    this._callbacks.add(cb);
    // Immediately fire current state
    cb(this.getState());
    return () => this._callbacks.delete(cb);
  }

  // ── public index lifecycle ──

  async rebuildIndex(): Promise<void> {
    // If already indexing, mark pending and wait for current to finish
    if (this._status === 'indexing') {
      this._pendingRebuild = true;
      await this._indexingPromise;
      // Another rebuild was already triggered by the pending flag, nothing to do
      return;
    }

    this._doRebuild();
    await this._indexingPromise;

    // If another rebuild was requested while we ran, honor it
    if (this._pendingRebuild) {
      this._pendingRebuild = false;
      await this.rebuildIndex();
    }
  }

  async indexFile(file: TFile): Promise<void> {
    // During full rebuild, record dirty paths for later catch-up
    if (this._status === 'indexing') {
      this._dirtyPaths.add(file.path);
      return;
    }

    const oldEntries = this.index.filter(e => e.path === file.path);
    this.removeFromDfMap(oldEntries);
    this.index = this.index.filter(e => e.path !== file.path);

    await this.indexFileInternal(file);
  }

  removeFile(path: string): void {
    const oldEntries = this.index.filter(e => e.path === path);
    this.removeFromDfMap(oldEntries);
    this.index = this.index.filter(e => e.path !== path);
  }

  renameFile(oldPath: string, newPath: string, newTitle: string): void {
    for (const entry of this.index) {
      if (entry.path === oldPath) {
        entry.path = newPath;
        entry.title = newTitle;
      }
    }
  }

  /**
   * Update chunking parameters and trigger a rebuild.
   * Keeps the same engine instance so status subscribers survive.
   */
  updateChunkSettings(chunkSize: number, chunkOverlap: number): void {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.rebuildIndex(); // fire-and-forget — UI follows status callbacks
  }

  // ── search ──

  search(query: string, topK = 10): SearchResult[] {
    if (this.index.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    // Stage 1: broad keyword recall
    const recallSize = Math.max(topK * 3, 30);
    const candidates = keywordSearch(queryTokens, recallSize, this.index, this.dfMap);

    // Stage 2: rich-signal rerank
    const reranked = rerank(query, queryTokens, candidates);

    // Deduplicate by file path, return top-k
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const { entry, score } of reranked) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      results.push({
        path: entry.path,
        title: entry.title,
        chunk: entry.content,
        score: Math.round(score * 100) / 100,
      });
      if (results.length >= topK) break;
    }

    return results;
  }

  // ── private helpers ──

  private _doRebuild(): void {
    this._indexingPromise = this._runRebuild();
  }

  private async _runRebuild(): Promise<void> {
    this._status = 'indexing';
    this._emit();

    try {
      this.index = [];
      this.dfMap.clear();

      const files = this.app.vault.getMarkdownFiles();
      const total = files.length;

      for (let i = 0; i < files.length; i++) {
        try {
          await this.indexFileInternal(files[i]);
        } catch {
          // File may have been deleted during rebuild — skip
        }
        // Emit progress periodically (every 10 files or every file for small vaults)
        if (i % 10 === 0 || i === files.length - 1) {
          this._emit(`Indexing ${i + 1}/${total} files…`);
        }
      }

      // Catch up on files that were modified/created during the rebuild
      if (this._dirtyPaths.size > 0) {
        const dirtyFiles: TFile[] = [];
        for (const path of this._dirtyPaths) {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) dirtyFiles.push(f);
        }
        this._dirtyPaths.clear();
        for (const f of dirtyFiles) {
          try { await this.indexFileInternal(f); } catch { /* skip */ }
        }
      }

      this.rebuildDfMap();
      this._status = 'ready';
      this._emit(`Index ready (${this.index.length} chunks)`);
    } catch (err) {
      this._status = 'error';
      this._emit(`Index error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async indexFileInternal(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const title = file.basename;
    const chunks = chunkText(content, this.chunkSize, this.chunkOverlap);

    const newEntries: ChunkEntry[] = [];
    for (const chunk of chunks) {
      if (chunk.trim().length < 20) continue;
      newEntries.push({
        path: file.path,
        title,
        content: chunk,
        tokens: tokenize(chunk),
      });
    }

    this.index.push(...newEntries);
    this.addToDfMap(newEntries);
  }

  private _buildMessage(): string {
    switch (this._status) {
      case 'idle': return 'Index not yet built';
      case 'indexing': return 'Indexing vault…';
      case 'ready': return `Index ready (${this.index.length} chunks)`;
      case 'error': return 'Index build failed';
    }
  }

  private _emit(messageOverride?: string): void {
    const state: IndexState = {
      status: this._status,
      message: messageOverride ?? this._buildMessage(),
      chunkCount: this.index.length,
    };
    for (const cb of this._callbacks) {
      try { cb(state); } catch { /* don't let one broken callback break others */ }
    }
  }

  // ── dfMap maintenance ──

  private rebuildDfMap(): void {
    this.dfMap.clear();
    for (const entry of this.index) {
      for (const token of entry.tokens.keys()) {
        this.dfMap.set(token, (this.dfMap.get(token) ?? 0) + 1);
      }
    }
  }

  private addToDfMap(entries: ChunkEntry[]): void {
    for (const entry of entries) {
      for (const token of entry.tokens.keys()) {
        this.dfMap.set(token, (this.dfMap.get(token) ?? 0) + 1);
      }
    }
  }

  private removeFromDfMap(entries: ChunkEntry[]): void {
    for (const entry of entries) {
      for (const token of entry.tokens.keys()) {
        const count = this.dfMap.get(token);
        if (count !== undefined) {
          if (count <= 1) this.dfMap.delete(token);
          else this.dfMap.set(token, count - 1);
        }
      }
    }
  }
}
