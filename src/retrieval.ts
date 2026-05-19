/**
 * Pure retrieval functions — no Obsidian dependencies.
 *
 * Extracted from RAGEngine so the search pipeline can be tested
 * without stubbing App / TFile / vault.
 */

export interface ChunkEntry {
  path: string;
  title: string;
  content: string;
  tokens: Map<string, number>;
}

// ── tokenize ──

export function tokenize(text: string): Map<string, number> {
  const tokens = new Map<string, number>();

  const words = text
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'`~@#$%^&*+=<>/\\|]+/)
    .filter(w => w.length >= 2);

  for (const word of words) {
    tokens.set(word, (tokens.get(word) ?? 0) + 1);
  }

  // Chinese bigrams
  const chineseChars = text.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < chineseChars.length - 1; i++) {
    const bigram = chineseChars.slice(i, i + 2);
    tokens.set(bigram, (tokens.get(bigram) ?? 0) + 1);
  }

  return tokens;
}

// ── chunkText ──

export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);

  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      if (chunkOverlap > 0 && current.length > chunkOverlap) {
        current = current.slice(-chunkOverlap);
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

// ── keywordSearch (Stage 1: broad recall) ──

export function keywordSearch(
  queryTokens: Map<string, number>,
  recallSize: number,
  index: ChunkEntry[],
  dfMap: Map<string, number>,
): { entry: ChunkEntry; score: number }[] {
  const scored: { entry: ChunkEntry; score: number }[] = [];
  const N = index.length;

  for (const entry of index) {
    let score = 0;
    for (const [token] of queryTokens) {
      const tf = entry.tokens.get(token);
      if (tf !== undefined) {
        const df = dfMap.get(token) ?? 0;
        const idf = Math.log(1 + N / (df + 1));
        score += tf * idf;
      }
    }
    // Title match bonus
    const titleLower = entry.title.toLowerCase();
    for (const [token] of queryTokens) {
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

// ── rerank (Stage 2: rich-signal rescoring) ──

export function rerank(
  query: string,
  queryTokens: Map<string, number>,
  candidates: { entry: ChunkEntry; score: number }[],
): { entry: ChunkEntry; score: number }[] {
  const queryLower = query.toLowerCase();

  const reranked = candidates.map(({ entry, score }) => {
    let finalScore = score;
    const content = entry.content.toLowerCase();
    const title = entry.title.toLowerCase();

    // 1. Exact phrase match
    if (content.includes(queryLower)) {
      finalScore *= 2.5;
    } else {
      // Partial: consecutive token bigrams
      let phraseHits = 0;
      const tokenList = [...queryTokens.keys()];
      for (let i = 0; i < tokenList.length - 1; i++) {
        const bigram = tokenList[i] + ' ' + tokenList[i + 1];
        if (content.includes(bigram)) phraseHits++;
      }
      finalScore *= (1 + phraseHits * 0.4);
    }

    // 2. Token proximity bonus
    finalScore += proximityBonus(queryTokens, content);

    // 3. Title match extra weight
    for (const [token] of queryTokens) {
      if (title.includes(token)) finalScore += 1.0;
    }

    return { entry, score: finalScore };
  });

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

// ── proximityBonus ──

export function proximityBonus(
  queryTokens: Map<string, number>,
  content: string,
): number {
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

  return Math.max(0, 3.0 * (1 - avgGap / (content.length + 1)));
}
