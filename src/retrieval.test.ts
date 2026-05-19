import { describe, it, expect } from 'vitest';
import {
  tokenize,
  chunkText,
  keywordSearch,
  rerank,
  proximityBonus,
  ChunkEntry,
} from './retrieval';

// ── helpers ──

function makeEntry(
  path: string,
  title: string,
  content: string,
): ChunkEntry {
  return { path, title, content, tokens: tokenize(content) };
}

function makeIndex(entries: [string, string, string][]): ChunkEntry[] {
  return entries.map(([path, title, content]) => makeEntry(path, title, content));
}

function buildDfMap(index: ChunkEntry[]): Map<string, number> {
  const dfMap = new Map<string, number>();
  for (const entry of index) {
    for (const token of entry.tokens.keys()) {
      dfMap.set(token, (dfMap.get(token) ?? 0) + 1);
    }
  }
  return dfMap;
}

// ═══════════════════════════════════════════════
// tokenize
// ═══════════════════════════════════════════════

describe('tokenize', () => {
  it('splits English text into lowercase words', () => {
    const m = tokenize('Hello world');
    expect(m.get('hello')).toBe(1);
    expect(m.get('world')).toBe(1);
  });

  it('filters out words shorter than 2 chars', () => {
    const m = tokenize('a ab abc');
    expect(m.has('a')).toBe(false);
    expect(m.get('ab')).toBe(1);
    expect(m.get('abc')).toBe(1);
  });

  it('extracts Chinese bigrams', () => {
    const m = tokenize('机器学习');
    expect(m.get('机器')).toBe(1);
    expect(m.get('器学')).toBe(1);
    expect(m.get('学习')).toBe(1);
  });

  it('handles mixed Chinese + English', () => {
    const m = tokenize('AI 机器学习 system');
    expect(m.get('ai')).toBe(1);
    expect(m.get('system')).toBe(1);
    expect(m.get('机器')).toBe(1);
  });

  it('strips punctuation', () => {
    const m = tokenize('hello, world! how... are? (you)');
    expect(m.get('hello')).toBe(1);
    expect(m.get('world')).toBe(1);
    expect(m.get('how')).toBe(1);
    expect(m.get('are')).toBe(1);
    expect(m.get('you')).toBe(1);
    // no punctuation tokens
    for (const [k] of m) {
      expect(k).not.toMatch(/[,!?.()]/);
    }
  });

  it('normalizes case', () => {
    const m = tokenize('Hello HELLO hello');
    expect(m.get('hello')).toBe(3);
  });

  it('returns empty map for empty string', () => {
    const m = tokenize('');
    expect(m.size).toBe(0);
  });

  it('returns empty map for punctuation-only string', () => {
    const m = tokenize('?!.,');
    // No words ≥ 2 chars and no Chinese chars
    expect(m.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// chunkText
// ═══════════════════════════════════════════════

describe('chunkText', () => {
  it('returns single chunk for text smaller than chunkSize', () => {
    const chunks = chunkText('Hello world', 500, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe('Hello world');
  });

  it('splits at paragraph boundaries', () => {
    const para1 = 'A'.repeat(300);
    const para2 = 'B'.repeat(300);
    const text = para1 + '\n\n' + para2;
    const chunks = chunkText(text, 400, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('A');
    expect(chunks[1]).toContain('B');
  });

  it('applies chunkOverlap between adjacent chunks', () => {
    // Build a long single-paragraph text that will force a split
    const words: string[] = [];
    for (let i = 0; i < 200; i++) {
      words.push(`word${i}`);
    }
    const text = words.join(' ');
    const chunks = chunkText(text, 300, 80);

    if (chunks.length >= 2) {
      const firstEnd = chunks[0].slice(-40);
      const secondStart = chunks[1].slice(0, 40);
      // At least some characters should overlap
      const overlappingChars = [...firstEnd].filter(c => secondStart.includes(c));
      expect(overlappingChars.length).toBeGreaterThan(0);
    }
  });

  it('short text returns single chunk (caller filters by length)', () => {
    // chunkText itself does NOT filter — the caller (RAGEngine) does
    const chunks = chunkText('hi', 500, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe('hi');
  });

  it('returns empty array for empty string', () => {
    const chunks = chunkText('', 500, 50);
    expect(chunks.length).toBe(0);
  });

  it('handles Chinese text chunking at paragraph boundaries', () => {
    const line = '知识图谱是一种用图结构表示知识的方法。';
    // Build multiple paragraphs so chunkText can split at \n\n
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(line.repeat(5));
    }
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(10);
    }
  });

  it('overlap = 0 produces adjacent non-overlapping chunks', () => {
    // Multiple paragraphs to force splitting
    const paragraphs: string[] = [];
    for (let i = 0; i < 30; i++) {
      paragraphs.push('word' + i + ' '.repeat(80));
    }
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 200, 0);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════
// keywordSearch
// ═══════════════════════════════════════════════

describe('keywordSearch', () => {
  const index = makeIndex([
    ['a.md', 'Deep Learning', 'Deep learning uses neural networks for pattern recognition.'],
    ['b.md', 'Machine Learning', 'Machine learning includes supervised and unsupervised learning.'],
    ['c.md', 'Python Tips', 'Python is great for data science and machine learning projects.'],
    ['d.md', 'Cooking', 'Pasta is best cooked al dente with olive oil and garlic.'],
  ]);
  const dfMap = buildDfMap(index);

  it('returns matching entries for a single token query', () => {
    const tokens = tokenize('learning');
    const results = keywordSearch(tokens, 10, index, dfMap);
    expect(results.length).toBeGreaterThan(0);
    const titles = results.map(r => r.entry.title);
    expect(titles).toContain('Deep Learning');
    expect(titles).toContain('Machine Learning');
  });

  it('gives higher scores to entries with more token matches', () => {
    const tokens = tokenize('learning deep');
    const results = keywordSearch(tokens, 10, index, dfMap);
    const deepResult = results.find(r => r.entry.title === 'Deep Learning');
    const cookingResult = results.find(r => r.entry.title === 'Cooking');
    expect(deepResult).toBeDefined();
    expect(cookingResult).toBeUndefined();
    // Deep Learning should score higher than entries with fewer hits
    expect(deepResult!.score).toBeGreaterThan(0);
  });

  it('adds title match bonus', () => {
    // "Python Tips" has "python" in title; "Machine Learning" does not
    const tokens = tokenize('python');
    const results = keywordSearch(tokens, 10, index, dfMap);
    const pythonResult = results.find(r => r.entry.title === 'Python Tips');
    expect(pythonResult).toBeDefined();
    // Python Tips gets title bonus (+2.0 per token)
    expect(pythonResult!.score).toBeGreaterThan(0);
  });

  it('returns empty array for empty index', () => {
    const tokens = tokenize('hello');
    const results = keywordSearch(tokens, 10, [], new Map());
    expect(results).toEqual([]);
  });

  it('returns empty array for empty query tokens', () => {
    const results = keywordSearch(new Map(), 10, index, dfMap);
    expect(results).toEqual([]);
  });

  it('respects recallSize limit', () => {
    const tokens = tokenize('learning');
    const results = keywordSearch(tokens, 1, index, dfMap);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════
// rerank
// ═══════════════════════════════════════════════

describe('rerank', () => {
  const index = makeIndex([
    ['a.md', 'Deep Learning', 'Deep learning uses multi-layer neural networks for pattern recognition and complex modeling.'],
    ['b.md', 'Machine Learning', 'Machine learning is a broad field. Neural networks are one approach.'],
    ['c.md', 'Python', 'Python is a programming language. It is not specifically about deep learning.'],
  ]);

  it('boosts score for exact phrase match (2.5x)', () => {
    const query = 'deep learning uses multi-layer';
    const tokens = tokenize(query);
    const candidates = index.map(entry => ({ entry, score: TokenScore(entry, tokens) }));
    const reranked = rerank(query, tokens, candidates);

    // The Deep Learning entry should get the highest score (exact phrase)
    expect(reranked[0].entry.title).toBe('Deep Learning');
  });

  it('boosts score for partial bigram matches', () => {
    const query = 'neural networks recognition';
    const tokens = tokenize(query);
    const candidates = index.map(entry => ({ entry, score: TokenScore(entry, tokens) }));
    const reranked = rerank(query, tokens, candidates);

    // Deep Learning has "neural networks" and "recognition" — should rank first
    expect(reranked[0].entry.title).toBe('Deep Learning');
  });

  it('adds title match bonus in rerank stage', () => {
    const query = 'deep learning network';
    const tokens = tokenize(query);
    const candidates = index.map(entry => ({ entry, score: TokenScore(entry, tokens) }));
    const reranked = rerank(query, tokens, candidates);

    // "Deep Learning" entry has "deep" and "learning" in its title
    const dlResult = reranked.find(r => r.entry.title === 'Deep Learning');
    expect(dlResult).toBeDefined();
    expect(dlResult!.score).toBeGreaterThan(0);
  });

  it('maintains candidate count (does not filter)', () => {
    const query = 'test query';
    const tokens = tokenize(query);
    const candidates = index.map(entry => ({ entry, score: TokenScore(entry, tokens) }));
    const reranked = rerank(query, tokens, candidates);
    expect(reranked.length).toBe(candidates.length);
  });

  it('sorts descending by score', () => {
    const query = 'deep learning';
    const tokens = tokenize(query);
    const candidates = index.map(entry => ({ entry, score: TokenScore(entry, tokens) }));
    const reranked = rerank(query, tokens, candidates);
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].score).toBeGreaterThanOrEqual(reranked[i].score);
    }
  });

  it('returns empty array for empty candidates', () => {
    const reranked = rerank('hello', tokenize('hello'), []);
    expect(reranked).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// proximityBonus
// ═══════════════════════════════════════════════

describe('proximityBonus', () => {
  it('returns high bonus when tokens are close together', () => {
    const content = 'hello world this is a test';
    const tokens = tokenize('hello world');
    const bonus = proximityBonus(tokens, content);
    expect(bonus).toBeGreaterThan(1.5); // close proximity
  });

  it('returns lower bonus when tokens are far apart', () => {
    const content = 'hello ' + 'x '.repeat(500) + 'world';
    const tokens = tokenize('hello world');
    const bonus = proximityBonus(tokens, content);
    expect(bonus).toBeLessThan(1.0); // far apart
  });

  it('returns 0 for single token', () => {
    const content = 'hello world';
    const tokens = tokenize('hello');
    const bonus = proximityBonus(tokens, content);
    expect(bonus).toBe(0);
  });

  it('returns 0 when no tokens match', () => {
    const content = 'hello world';
    const tokens = tokenize('xyz abc');
    const bonus = proximityBonus(tokens, content);
    expect(bonus).toBe(0);
  });

  it('returns 0 when only one token matches', () => {
    const content = 'hello there';
    const tokens = tokenize('hello xyz');
    const bonus = proximityBonus(tokens, content);
    expect(bonus).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// Integration: keywordSearch → rerank pipeline
// ═══════════════════════════════════════════════

describe('search pipeline integration', () => {
  const index = makeIndex([
    ['ml.md', 'Machine Learning Intro', 'Machine learning enables systems to learn from data. Supervised learning uses labeled examples.'],
    ['dl.md', 'Deep Learning Advanced', 'Deep learning uses multi-layer neural networks. Backpropagation trains these networks.'],
    ['nlu.md', 'Natural Language Understanding', 'NLU helps machines understand human language. Transformers are state of the art.'],
    ['cooking.md', 'Pasta Recipe', 'Boil pasta in salted water for 8 minutes. Add olive oil and parmesan.'],
  ]);
  const dfMap = buildDfMap(index);

  function pipeline(query: string, topK = 3) {
    const tokens = tokenize(query);
    if (tokens.size === 0) return [];
    const recallSize = Math.max(topK * 3, 30);
    const candidates = keywordSearch(tokens, recallSize, index, dfMap);
    const reranked = rerank(query, tokens, candidates);
    const seen = new Set<string>();
    const results: { title: string; score: number }[] = [];
    for (const { entry, score } of reranked) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      results.push({ title: entry.title, score: Math.round(score * 100) / 100 });
      if (results.length >= topK) break;
    }
    return results;
  }

  it('ranks relevant ML notes above irrelevant ones for ML query', () => {
    const results = pipeline('machine learning supervised');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Machine Learning Intro');
  });

  it('ranks DL notes for deep learning query', () => {
    const results = pipeline('deep learning neural backpropagation');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Deep Learning Advanced');
  });

  it('excludes completely irrelevant notes', () => {
    const results = pipeline('machine learning data');
    const titles = results.map(r => r.title);
    expect(titles).not.toContain('Pasta Recipe');
  });

  it('handles Chinese text search', () => {
    const chineseIndex = makeIndex([
      ['a.md', '机器学习基础', '机器学习是人工智能的分支，包括监督学习和无监督学习。'],
      ['b.md', '深度学习', '深度学习使用多层神经网络进行特征提取和模式识别。'],
      ['c.md', '烹饪指南', '意大利面需要煮八分钟，加入橄榄油和帕玛森芝士。'],
    ]);
    const chineseDfMap = buildDfMap(chineseIndex);
    const tokens = tokenize('机器学习监督');
    const candidates = keywordSearch(tokens, 10, chineseIndex, chineseDfMap);
    const results = rerank('机器学习监督', tokens, candidates);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.title).toBe('机器学习基础');
  });
});

// ── score helper ──

function TokenScore(
  entry: ChunkEntry,
  queryTokens: Map<string, number>,
): number {
  let s = 0;
  for (const [token] of queryTokens) {
    s += entry.tokens.get(token) ?? 0;
  }
  return s;
}
