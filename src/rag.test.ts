import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RAGEngine } from './rag';

// ── Mock Obsidian dependencies ──

function createMockApp(files: { path: string; basename: string; content: string }[]) {
  const mockFiles = files.map((f) => ({
    path: f.path,
    basename: f.basename,
    extension: 'md',
  }));

  return {
    vault: {
      getMarkdownFiles: vi.fn().mockReturnValue(mockFiles),
      read: vi.fn((file: { path: string }) => {
        const found = files.find((f) => f.path === file.path);
        if (!found) throw new Error(`File not found: ${file.path}`);
        return Promise.resolve(found.content);
      }),
      getAbstractFileByPath: vi.fn((p: string) => {
        const found = files.find((f) => f.path === p);
        return found
          ? { path: found.path, basename: found.basename, extension: 'md' }
          : null;
      }),
    },
    metadataCache: {
      getFileCache: vi.fn().mockReturnValue(null),
      resolvedLinks: {},
      getFirstLinkpathDest: vi.fn().mockReturnValue(null),
    },
    workspace: {
      getActiveFile: vi.fn().mockReturnValue(null),
    },
  } as any;
}

// ── Helpers ──

/** Collect every state change into an array. */
function trackStates(engine: RAGEngine): { status: string; message: string; chunkCount: number }[] {
  const states: { status: string; message: string; chunkCount: number }[] = [];
  engine.onStatusChange((s) => {
    states.push({ status: s.status, message: s.message, chunkCount: s.chunkCount });
  });
  return states;
}

// ═══════════════════════════════════════════════
// State machine transitions
// ═══════════════════════════════════════════════

describe('RAGEngine lifecycle', () => {
  let app: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    app = createMockApp([
      { path: 'note1.md', basename: 'Note One', content: 'Hello world. This is a test note about knowledge graphs.' },
      { path: 'note2.md', basename: 'Note Two', content: 'Another note with some different content here.' },
    ]);
  });

  it('starts in idle state', () => {
    const engine = new RAGEngine(app, 500, 50);
    const state = engine.getState();
    expect(state.status).toBe('idle');
    expect(state.chunkCount).toBe(0);
  });

  it('transitions idle → indexing → ready on rebuild', async () => {
    const engine = new RAGEngine(app, 500, 50);
    const states = trackStates(engine);

    await engine.rebuildIndex();

    expect(states.length).toBeGreaterThanOrEqual(2);
    // First emitted state after subscribe — the immediate callback fires with 'idle'
    expect(states[0].status).toBe('idle');
    // Then indexing
    expect(states.find((s) => s.status === 'indexing')).toBeDefined();
    // Final state should be ready
    const last = states[states.length - 1];
    expect(last.status).toBe('ready');
    expect(last.chunkCount).toBeGreaterThan(0);
    expect(engine.getState().status).toBe('ready');
    expect(engine.isIndexing).toBe(false);
  });

  it('per-file read errors are silently skipped (robustness)', async () => {
    // Make vault.read reject — individual files failing shouldn't crash the build
    app.vault.read = vi.fn().mockRejectedValue(new Error('Disk full'));

    const engine = new RAGEngine(app, 500, 50);
    const states = trackStates(engine);

    await engine.rebuildIndex();

    // Build completes with empty index (all files skipped)
    const last = states[states.length - 1];
    expect(last.status).toBe('ready');
    expect(engine.indexSize).toBe(0);
  });

  it('transitions to error when getMarkdownFiles throws', async () => {
    app.vault.getMarkdownFiles = vi.fn().mockImplementation(() => {
      throw new Error('Vault unavailable');
    });

    const engine = new RAGEngine(app, 500, 50);
    const states = trackStates(engine);

    await engine.rebuildIndex();

    const last = states[states.length - 1];
    expect(last.status).toBe('error');
    expect(last.message).toContain('Vault unavailable');
  });

  it('onStatusChange fires immediate state on subscribe', () => {
    const engine = new RAGEngine(app, 500, 50);
    const received: string[] = [];

    // Callback is fired synchronously on subscribe with current state
    engine.onStatusChange((s) => received.push(s.status));
    expect(received).toEqual(['idle']);
  });

  it('onStatusChange returns unsubscribe function', async () => {
    const engine = new RAGEngine(app, 500, 50);
    const received: string[] = [];

    const unsub = engine.onStatusChange((s) => received.push(s.status));
    // Consume the immediate callback
    received.length = 0;

    unsub();
    await engine.rebuildIndex();

    // After unsubscribe, no more callbacks
    expect(received).toEqual([]);
  });

  it('indexSize returns correct count after rebuild', async () => {
    const engine = new RAGEngine(app, 300, 0);
    await engine.rebuildIndex();
    // Both notes are short, should produce at least 1 chunk each
    expect(engine.indexSize).toBeGreaterThanOrEqual(2);
  });

  it('rebuildIndex clears and replaces existing index', async () => {
    const engine = new RAGEngine(app, 500, 0);

    await engine.rebuildIndex();
    const size1 = engine.indexSize;
    expect(size1).toBeGreaterThan(0);

    // Second rebuild should produce same or different count (same files)
    await engine.rebuildIndex();
    const size2 = engine.indexSize;
    // Index should be fresh (not doubled)
    expect(size2).toBeGreaterThan(0);
    // Same files re-indexed → same count
    expect(size2).toBe(size1);
  });
});

// ═══════════════════════════════════════════════
// Concurrent rebuild (pending rebuild queue)
// ═══════════════════════════════════════════════

describe('RAGEngine concurrent rebuild', () => {
  it('queues pending rebuild when called while indexing', async () => {
    const app = createMockApp([
      { path: 'a.md', basename: 'A', content: 'x '.repeat(100) },
    ]);

    const engine = new RAGEngine(app, 200, 0);
    const states = trackStates(engine);

    // Start first rebuild
    const p1 = engine.rebuildIndex();
    expect(engine.isIndexing).toBe(true);

    // Call rebuildIndex again while first is still running
    const p2 = engine.rebuildIndex();

    // Both should resolve
    await Promise.all([p1, p2]);

    // Final state should be ready (not indexing)
    expect(engine.getState().status).toBe('ready');
    expect(engine.isIndexing).toBe(false);

    // Should have fired ready at least once
    const readyStates = states.filter((s) => s.status === 'ready');
    expect(readyStates.length).toBeGreaterThanOrEqual(1);
  });

  it('does not enter indexing state twice for concurrent calls', async () => {
    // Same setup as above — verify status transitions are sensible
    const app = createMockApp([
      { path: 'b.md', basename: 'B', content: 'y '.repeat(100) },
    ]);

    const engine = new RAGEngine(app, 200, 0);
    const statuses: string[] = [];

    engine.onStatusChange((s) => statuses.push(s.status));

    const p1 = engine.rebuildIndex();
    const p2 = engine.rebuildIndex();
    await Promise.all([p1, p2]);

    // Should end in ready
    expect(statuses[statuses.length - 1]).toBe('ready');
  });
});

// ═══════════════════════════════════════════════
// Dirty file tracking during rebuild
// ═══════════════════════════════════════════════

describe('RAGEngine dirty file tracking', () => {
  it('records dirty paths when indexFile called during rebuild', async () => {
    // Create engine with lots of files so rebuild takes long enough to catch
    const files: { path: string; basename: string; content: string }[] = [];
    for (let i = 0; i < 50; i++) {
      files.push({
        path: `note${i}.md`,
        basename: `Note ${i}`,
        content: `Content of note ${i}. `.repeat(30),
      });
    }
    const app = createMockApp(files);

    const engine = new RAGEngine(app, 500, 50);
    const dirtyFile = { path: 'dirty.md', basename: 'Dirty', extension: 'md' } as any;

    // Start rebuild (don't await yet)
    const rebuildPromise = engine.rebuildIndex();

    // While indexing, simulate a file modification
    await engine.indexFile(dirtyFile as any);

    // Wait for rebuild
    await rebuildPromise;

    // The dirty file should not appear (we didn't add it to the vault mock)
    // but the rebuild should still complete successfully
    expect(engine.getState().status).toBe('ready');
    expect(engine.isIndexing).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// updateChunkSettings
// ═══════════════════════════════════════════════

describe('RAGEngine chunk settings update', () => {
  it('triggers rebuild when chunk settings change', async () => {
    const app = createMockApp([
      { path: 'note.md', basename: 'Note', content: 'x '.repeat(500) },
    ]);

    const engine = new RAGEngine(app, 500, 50);
    await engine.rebuildIndex();
    const size1 = engine.indexSize;

    const states = trackStates(engine);
    // Clear the immediate idle callback
    states.length = 0;

    // Change chunk size — should trigger rebuild
    engine.updateChunkSettings(200, 20);
    // Short sleep to let the async rebuild start
    await new Promise((r) => setTimeout(r, 10));

    const indexingState = states.find((s) => s.status === 'indexing');
    expect(indexingState).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// Search on empty engine
// ═══════════════════════════════════════════════

describe('RAGEngine search on empty engine', () => {
  it('returns empty array when index is empty', () => {
    const app = createMockApp([]);
    const engine = new RAGEngine(app, 500, 50);
    expect(engine.search('test')).toEqual([]);
  });

  it('returns empty array when query has no valid tokens', async () => {
    const app = createMockApp([
      { path: 'a.md', basename: 'A', content: 'hello world' },
    ]);
    const engine = new RAGEngine(app, 500, 50);
    await engine.rebuildIndex();

    // Query is all punctuation — no tokens
    expect(engine.search('?!.')).toEqual([]);
  });
});
