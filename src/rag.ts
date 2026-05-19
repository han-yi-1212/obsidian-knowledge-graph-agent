import { App, TFile } from 'obsidian';
import type { SearchResult } from './types';

interface ChunkEntry {
  path: string;
  title: string;
  content: string;
  /** Tokenized words for scoring */
  tokens: Map<string, number>;
}

/**
 * Simple TF-IDF inspired retrieval engine.
 *
 * For the MVP we use term-frequency scoring against an in-memory index.
 * Later this can be replaced with embeddings + vector DB.
 */
export class RAGEngine {
  private app: App;
  private index: ChunkEntry[] = [];
  private dfMap: Map<string, number> = new Map();
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(app: App, chunkSize = 500, chunkOverlap = 50) {
    this.app = app;
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  get indexSize(): number {
    return this.index.length;
  }

  /**
   * Rebuild the full index from all markdown files in the vault.
   */
  async rebuildIndex(): Promise<void> {
    this.index = [];
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      await this.indexFileInternal(file);
    }

    this.rebuildDfMap();
  }

  /**
   * Index or re-index a single file (public API).
   */
  async indexFile(file: TFile): Promise<void> {
    // Remove old entries from both index and dfMap
    const oldEntries = this.index.filter(e => e.path === file.path);
    this.removeFromDfMap(oldEntries);
    this.index = this.index.filter(e => e.path !== file.path);

    await this.indexFileInternal(file);
  }

  /**
   * Remove a file from the index.
   */
  removeFile(path: string): void {
    const oldEntries = this.index.filter(e => e.path === path);
    this.removeFromDfMap(oldEntries);
    this.index = this.index.filter(e => e.path !== path);
  }

  /**
   * Rename a file's entries in the index.
   */
  renameFile(oldPath: string, newPath: string, newTitle: string): void {
    for (const entry of this.index) {
      if (entry.path === oldPath) {
        entry.path = newPath;
        entry.title = newTitle;
      }
    }
  }

  /**
   * Two-stage retrieval: keyword recall → reranker → top-k results.
   */
  search(query: string, topK = 10): SearchResult[] {
    if (this.index.length === 0) return [];

    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return [];

    // Stage 1: TF-IDF keyword recall (top 30 or topK×3, whichever is larger)
    const recallSize = Math.max(topK * 3, 30);
    const candidates = this.keywordSearch(query, queryTokens, recallSize);

    // Stage 2: Rerank with phrase matching, proximity, and title bonus
    const reranked = this.rerank(query, queryTokens, candidates);

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

  /**
   * Stage 1: TF-IDF keyword search with broad recall.
   */
  private keywordSearch(
    query: string,
    queryTokens: Map<string, number>,
    recallSize: number,
  ): { entry: ChunkEntry; score: number }[] {
    const scored: { entry: ChunkEntry; score: number }[] = [];

    for (const entry of this.index) {
      let score = 0;
      for (const [token, _] of queryTokens) {
        const tf = entry.tokens.get(token);
        if (tf !== undefined) {
          const df = this.dfMap.get(token) ?? 0;
          const idf = Math.log(1 + this.index.length / (df + 1));
          score += tf * idf;
        }
      }
      // Bonus for title matches
      const titleLower = entry.title.toLowerCase();
      for (const [token, _] of queryTokens) {
        if (titleLower.includes(token)) {
          score += 2.0;
        }
      }
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, recallSize);
  }

  /**
   * Stage 2: Reranker — re-scores candidates with richer signals.
   */
  private rerank(
    query: string,
    queryTokens: Map<string, number>,
    candidates: { entry: ChunkEntry; score: number }[],
  ): { entry: ChunkEntry; score: number }[] {
    const queryLower = query.toLowerCase();

    const reranked = candidates.map(({ entry, score }) => {
      let finalScore = score;
      const content = entry.content.toLowerCase();
      const title = entry.title.toLowerCase();

      // 1. Exact phrase match (strongest single signal)
      if (content.includes(queryLower)) {
        finalScore *= 2.5;
      } else {
        // Partial phrase: check consecutive token pairs
        let phraseHits = 0;
        const tokenList = [...queryTokens.keys()];
        for (let i = 0; i < tokenList.length - 1; i++) {
          const bigram = tokenList[i] + ' ' + tokenList[i + 1];
          if (content.includes(bigram)) phraseHits++;
        }
        finalScore *= (1 + phraseHits * 0.4);
      }

      // 2. Token proximity bonus (closer = more relevant)
      finalScore += this.proximityBonus(queryTokens, content);

      // 3. Title match extra weight
      for (const [token] of queryTokens) {
        if (title.includes(token)) finalScore += 1.0;
      }

      return { entry, score: finalScore };
    });

    reranked.sort((a, b) => b.score - a.score);
    return reranked;
  }

  /**
   * Heuristic: tokens appearing closer together in the content = stronger signal.
   * Returns 0–3 bonus points.
   */
  private proximityBonus(queryTokens: Map<string, number>, content: string): number {
    const positions: number[] = [];
    for (const [token] of queryTokens) {
      const idx = content.indexOf(token);
      if (idx !== -1) positions.push(idx);
    }

    if (positions.length < 2) return 0;

    positions.sort((a, b) => a - b);

    let totalGap = 0;
    for (let i = 1; i < positions.length; i++) {
      totalGap += positions[i] - positions[i - 1];
    }
    const avgGap = totalGap / (positions.length - 1);

    // Closer proximity → higher bonus, capped at 3
    return Math.max(0, 3.0 * (1 - avgGap / (content.length + 1)));
  }

  // ── private helpers ──

  /**
   * Index a file's content without updating dfMap (caller handles dfMap).
   */
  private async indexFileInternal(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const title = file.basename;
    const chunks = this.chunkText(content);

    const newEntries: ChunkEntry[] = [];
    for (const chunk of chunks) {
      if (chunk.trim().length < 20) continue;
      newEntries.push({
        path: file.path,
        title,
        content: chunk,
        tokens: this.tokenize(chunk),
      });
    }

    this.index.push(...newEntries);
    this.addToDfMap(newEntries);
  }

  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);

    let current = '';
    for (const para of paragraphs) {
      if (current.length + para.length > this.chunkSize && current.length > 0) {
        chunks.push(current.trim());
        // Keep last chunkOverlap chars as overlap seed for next chunk
        if (this.chunkOverlap > 0 && current.length > this.chunkOverlap) {
          current = current.slice(-this.chunkOverlap);
        } else {
          current = '';
        }
      }
      current += (current ? '\n\n' : '') + para;
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  private tokenize(text: string): Map<string, number> {
    const tokens = new Map<string, number>();
    // Split on non-Chinese, non-alphanumeric boundaries
    const words = text
      .toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"'`~@#$%^&*+=<>/\\|]+/)
      .filter(w => w.length >= 2);

    for (const word of words) {
      tokens.set(word, (tokens.get(word) ?? 0) + 1);
    }

    // Also extract Chinese bigrams (simple n-gram)
    const chineseChars = text.replace(/[^一-鿿]/g, '');
    for (let i = 0; i < chineseChars.length - 1; i++) {
      const bigram = chineseChars.slice(i, i + 2);
      tokens.set(bigram, (tokens.get(bigram) ?? 0) + 1);
    }

    return tokens;
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
