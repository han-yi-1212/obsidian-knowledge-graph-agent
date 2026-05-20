import { describe, it, expect, vi } from 'vitest';
import {
  parseDraftsFromResponse,
  sanitizeTitle,
  sanitizeFolder,
  sanitizeDrafts,
  validateDrafts,
  resolvePath,
  checkConflicts,
  createNotesFromDrafts,
  summarizeResults,
  MAX_DRAFTS,
} from './note-drafts';
import type { NoteDraft, DraftCreateResult } from './note-drafts';

// ── parseDraftsFromResponse ──

describe('parseDraftsFromResponse', () => {
  it('parses pure JSON with notes array', () => {
    const json = JSON.stringify({
      notes: [
        { title: 'Note A', content: '# Hello' },
        { title: 'Note B', content: '## World', folder: 'Ideas' },
      ],
    });
    const result = parseDraftsFromResponse(json);
    expect(result).toHaveLength(2);
    expect(result![0].title).toBe('Note A');
    expect(result![0].content).toBe('# Hello');
    expect(result![1].folder).toBe('Ideas');
  });

  it('parses JSON inside markdown code fence', () => {
    const text = `Sure, here are your drafts:

\`\`\`json
{
  "notes": [
    {"title": "Fenced Note", "content": "# Fenced"}
  ]
}
\`\`\`

Hope this helps!`;
    const result = parseDraftsFromResponse(text);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Fenced Note');
  });

  it('parses JSON code fence without json tag', () => {
    const text = `\`\`\`
{"notes": [{"title": "Plain", "content": "ok"}]}
\`\`\``;
    const result = parseDraftsFromResponse(text);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Plain');
  });

  it('parses JSON with explanatory text before and after', () => {
    const text = `Here are your drafts.

{
  "notes": [
    {"title": "Mixed", "content": "surrounded by text"}
  ]
}

Let me know if you need changes.`;
    const result = parseDraftsFromResponse(text);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Mixed');
  });

  it('returns null for invalid JSON', () => {
    expect(parseDraftsFromResponse('not valid json at all')).toBeNull();
  });

  it('returns null for JSON without notes array', () => {
    expect(parseDraftsFromResponse('{"other": "value"}')).toBeNull();
  });

  it('returns null for empty notes array', () => {
    expect(parseDraftsFromResponse('{"notes": []}')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDraftsFromResponse('')).toBeNull();
  });

  it('skips malformed items in notes array', () => {
    const json = JSON.stringify({
      notes: [
        { notTitle: 'x', notContent: 'y' },
        { title: 'Good', content: 'valid' },
      ],
    });
    const result = parseDraftsFromResponse(json);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Good');
  });

  it('trims whitespace from titles', () => {
    const json = JSON.stringify({
      notes: [{ title: '  Spaced Title  ', content: 'x' }],
    });
    const result = parseDraftsFromResponse(json);
    expect(result![0].title).toBe('Spaced Title');
  });

  it('handles nested braces in content', () => {
    const text = `{"notes": [{"title": "With JSON in content", "content": "Here is {some} nested {braces}"}]}`;
    const result = parseDraftsFromResponse(text);
    expect(result).toHaveLength(1);
    expect(result![0].content).toContain('{some}');
  });

  it('captures links array when present', () => {
    const json = JSON.stringify({
      notes: [{ title: 'Linked', content: 'x', links: ['A', 'B'] }],
    });
    const result = parseDraftsFromResponse(json);
    expect(result![0].links).toEqual(['A', 'B']);
  });

  it('returns null for array JSON (no notes key)', () => {
    expect(parseDraftsFromResponse('[1, 2, 3]')).toBeNull();
  });
});

// ── sanitizeTitle ──

describe('sanitizeTitle', () => {
  it('returns the same clean title', () => {
    expect(sanitizeTitle('Clean Title')).toBe('Clean Title');
  });

  it('strips illegal filename characters', () => {
    expect(sanitizeTitle('Test: The "Best" <thing>')).toBe('Test The Best thing');
  });

  it('returns "Untitled" for empty input', () => {
    expect(sanitizeTitle('')).toBe('Untitled');
  });

  it('returns "Untitled" for only illegal chars', () => {
    expect(sanitizeTitle('\\/:*?"<>|')).toBe('Untitled');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeTitle('Too   Many    Spaces')).toBe('Too Many Spaces');
  });
});

// ── sanitizeFolder ──

describe('sanitizeFolder', () => {
  it('returns "AI Notes" for undefined', () => {
    expect(sanitizeFolder(undefined)).toBe('AI Notes');
  });

  it('returns "AI Notes" for empty string', () => {
    expect(sanitizeFolder('')).toBe('AI Notes');
  });

  it('strips illegal chars from each segment', () => {
    expect(sanitizeFolder('Bad:Folder')).toBe('BadFolder');
  });

  it('removes . and .. segments', () => {
    expect(sanitizeFolder('Notes/./sub/../real')).toBe('Notes/sub/real');
  });

  it('removes empty segments from double slashes', () => {
    expect(sanitizeFolder('Notes//child')).toBe('Notes/child');
  });

  it('handles backslash separators', () => {
    expect(sanitizeFolder('Notes\\child')).toBe('Notes/child');
  });

  it('returns "AI Notes" when all segments are cleaned away', () => {
    expect(sanitizeFolder('./..')).toBe('AI Notes');
  });
});

// ── sanitizeDrafts ──

describe('sanitizeDrafts', () => {
  it('cleans titles with illegal chars and reports warnings', () => {
    const drafts: NoteDraft[] = [
      { title: 'Bad:Title', folder: 'OK', content: 'x' },
    ];
    const { cleaned, warnings } = sanitizeDrafts(drafts);
    expect(cleaned[0].title).toBe('BadTitle');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('title');
    expect(warnings[0].original).toBe('Bad:Title');
    expect(warnings[0].cleaned).toBe('BadTitle');
  });

  it('sanitizes dangerous folder paths and reports warnings', () => {
    const drafts: NoteDraft[] = [
      { title: 'OK', folder: 'notes/../escape', content: 'x' },
    ];
    const { cleaned, warnings } = sanitizeDrafts(drafts);
    expect(cleaned[0].folder).toBe('notes/escape');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('folder');
  });

  it('leaves clean drafts unchanged with no warnings', () => {
    const drafts: NoteDraft[] = [
      { title: 'Clean Note', folder: 'My Notes', content: 'x' },
    ];
    const { cleaned, warnings } = sanitizeDrafts(drafts);
    expect(cleaned[0]).toEqual(drafts[0]);
    expect(warnings).toHaveLength(0);
  });

  it('handles multiple drafts with mixed issues', () => {
    const drafts: NoteDraft[] = [
      { title: '<Bad>', content: 'a' },
      { title: 'Good', content: 'b' },
    ];
    const { cleaned, warnings } = sanitizeDrafts(drafts);
    expect(cleaned[0].title).toBe('Bad');
    expect(cleaned[1].title).toBe('Good');
    expect(warnings).toHaveLength(1);
  });
});

// ── validateDrafts ──

describe('validateDrafts', () => {
  it('returns no errors for valid drafts', () => {
    const drafts: NoteDraft[] = [
      { title: 'Valid Note', content: 'Some content' },
    ];
    expect(validateDrafts(drafts)).toHaveLength(0);
  });

  it('catches empty title', () => {
    const errors = validateDrafts([{ title: '', content: 'x' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('title');
  });

  it('catches empty content', () => {
    const errors = validateDrafts([{ title: 'T', content: '' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('content');
  });

  it('catches whitespace-only content', () => {
    const errors = validateDrafts([{ title: 'T', content: '   ' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('content');
  });

  it('does NOT reject illegal filename chars (handled by sanitize)', () => {
    const errors = validateDrafts([{ title: 'Bad:Char', content: 'x' }]);
    expect(errors).toHaveLength(0);
  });

  it('returns multiple errors for multiple drafts', () => {
    const drafts: NoteDraft[] = [
      { title: '', content: '' },
      { title: 'OK', content: '' },
    ];
    const errors = validateDrafts(drafts);
    expect(errors).toHaveLength(3); // 2 for draft 0 (title+content) + 1 for draft 1
  });
});

// ── resolvePath ──

describe('resolvePath', () => {
  it('uses default folder when none provided', () => {
    const draft: NoteDraft = { title: 'My Note', content: 'x', folder: undefined };
    expect(resolvePath(draft)).toBe('AI Notes/My Note.md');
  });

  it('uses provided folder', () => {
    const draft: NoteDraft = { title: 'Note', content: 'x', folder: 'Projects' };
    expect(resolvePath(draft)).toBe('Projects/Note.md');
  });

  it('sanitizes folder path', () => {
    const draft: NoteDraft = { title: 'Note', content: 'x', folder: 'evil/../safe' };
    expect(resolvePath(draft)).toBe('evil/safe/Note.md');
  });
});

// ── checkConflicts ──

describe('checkConflicts', () => {
  it('returns empty map when no files exist', () => {
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
      },
    } as any;
    const drafts: NoteDraft[] = [
      { title: 'New Note', content: 'x' },
    ];
    const conflicts = checkConflicts(drafts, app);
    expect(conflicts.size).toBe(0);
  });

  it('detects existing file at target path', () => {
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) =>
          path === 'AI Notes/Existing.md' ? { path } : null,
        ),
      },
    } as any;
    const drafts: NoteDraft[] = [
      { title: 'Existing', content: 'x' },
      { title: 'New', content: 'y' },
    ];
    const conflicts = checkConflicts(drafts, app);
    expect(conflicts.size).toBe(1);
    expect(conflicts.get(0)).toBe('AI Notes/Existing.md');
  });
});

// ── summarizeResults ──

describe('summarizeResults', () => {
  it('reports created count', () => {
    const results: DraftCreateResult[] = [
      { draft: { title: 'A', content: 'x' }, path: 'AI Notes/A.md', status: 'created' },
    ];
    const summary = summarizeResults(results);
    expect(summary).toContain('1 created');
    expect(summary).toContain('✅');
    expect(summary).toContain('[[A]]');
  });

  it('reports renamed count', () => {
    const results: DraftCreateResult[] = [
      {
        draft: { title: 'B - 2', content: 'x' },
        path: 'AI Notes/B - 2.md',
        status: 'renamed',
        originalPath: 'AI Notes/B.md',
      },
    ];
    const summary = summarizeResults(results);
    expect(summary).toContain('1 renamed');
    expect(summary).toContain('🔄');
  });

  it('reports errors', () => {
    const results: DraftCreateResult[] = [
      {
        draft: { title: 'Fail', content: 'x' },
        path: 'AI Notes/Fail.md',
        status: 'error',
        error: 'Permission denied',
      },
    ];
    const summary = summarizeResults(results);
    expect(summary).toContain('1 failed');
    expect(summary).toContain('❌');
    expect(summary).toContain('Permission denied');
  });

  it('combines multiple statuses', () => {
    const results: DraftCreateResult[] = [
      { draft: { title: 'A', content: 'x' }, path: 'p/a.md', status: 'created' },
      { draft: { title: 'B', content: 'x' }, path: 'p/b.md', status: 'created' },
      { draft: { title: 'C', content: 'x' }, path: 'p/c.md', status: 'renamed' },
    ];
    const summary = summarizeResults(results);
    expect(summary).toContain('2 created');
    expect(summary).toContain('1 renamed');
  });
});

// ── createNotesFromDrafts ──

describe('createNotesFromDrafts', () => {
  function setupMocks(existingPaths: string[] = []) {
    const createdPaths: string[] = [];
    const createdContents: string[] = [];
    const createdFolders: string[] = [];
    const indexedFiles: any[] = [];

    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (existingPaths.includes(path)) return { path };
          if (createdPaths.includes(path)) return { path };
          return null;
        }),
        createFolder: vi.fn(async (path: string) => {
          createdFolders.push(path);
          return { path };
        }),
        create: vi.fn(async (path: string, content: string) => {
          createdPaths.push(path);
          createdContents.push(content);
          return { path, extension: 'md' };
        }),
      },
    } as any;

    const ragEngine = {
      indexFile: vi.fn(async (file: any) => {
        indexedFiles.push(file);
      }),
    } as any;

    return { app, ragEngine, createdPaths, createdContents, createdFolders, indexedFiles };
  }

  it('creates a single note in default folder', async () => {
    const { app, ragEngine, createdPaths, createdFolders } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'My Note', content: '# Hello world', folder: undefined },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('created');
    expect(results[0].path).toBe('AI Notes/My Note.md');
    expect(createdPaths).toContain('AI Notes/My Note.md');
    expect(createdFolders).toContain('AI Notes');
  });

  it('creates notes in a custom folder', async () => {
    const { app, ragEngine, createdPaths, createdFolders } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'Project Alpha', content: '## Roadmap', folder: 'Projects' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results[0].path).toBe('Projects/Project Alpha.md');
    expect(createdFolders).toContain('Projects');
  });

  it('creates nested folders recursively', async () => {
    const { app, ragEngine, createdPaths, createdFolders } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'Deep Note', content: 'deep', folder: 'A/B/C' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('created');
    // Should create A, then A/B, then A/B/C
    expect(createdFolders).toContain('A');
    expect(createdFolders).toContain('A/B');
    expect(createdFolders).toContain('A/B/C');
  });

  it('auto-renames when file already exists', async () => {
    const { app, ragEngine, createdPaths } = setupMocks([
      'AI Notes/Dupe.md', // pre-existing conflict
    ]);
    const drafts: NoteDraft[] = [
      { title: 'Dupe', content: 'second copy' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results[0].status).toBe('renamed');
    expect(results[0].path).toBe('AI Notes/Dupe - 2.md');
    expect(results[0].originalPath).toBe('AI Notes/Dupe.md');
    expect(createdPaths).toContain('AI Notes/Dupe - 2.md');
  });

  it('increments suffix when -2 already exists', async () => {
    const { app, ragEngine } = setupMocks([
      'AI Notes/Dupe.md',
      'AI Notes/Dupe - 2.md',
    ]);
    const drafts: NoteDraft[] = [
      { title: 'Dupe', content: 'third copy' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results[0].status).toBe('renamed');
    expect(results[0].path).toBe('AI Notes/Dupe - 3.md');
  });

  it('calls ragEngine.indexFile for each created note', async () => {
    const { app, ragEngine, indexedFiles } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'A', content: 'a' },
      { title: 'B', content: 'b' },
    ];

    await createNotesFromDrafts(drafts, app, ragEngine);

    expect(ragEngine.indexFile).toHaveBeenCalledTimes(2);
    expect(indexedFiles[0].path).toBe('AI Notes/A.md');
    expect(indexedFiles[1].path).toBe('AI Notes/B.md');
  });

  it('captures errors without throwing', async () => {
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockRejectedValue(new Error('Disk full')),
      },
    } as any;
    const ragEngine = { indexFile: vi.fn() } as any;

    const drafts: NoteDraft[] = [
      { title: 'Fail', content: 'x' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('Disk full');
  });

  it('skips folder creation when folder already exists', async () => {
    const { app, ragEngine, createdFolders } = setupMocks(['AI Notes']); // folder exists as file
    // Use a fresh app where the folder already "exists"
    const app2 = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (path === 'AI Notes') return { path }; // folder exists
          return null; // file does not exist
        }),
        createFolder: vi.fn(async () => ({})),
        create: vi.fn(async (path: string, content: string) => ({ path, extension: 'md' })),
      },
    } as any;

    const drafts: NoteDraft[] = [
      { title: 'Fresh', content: 'x' },
    ];

    await createNotesFromDrafts(drafts, app2, ragEngine);

    expect(app2.vault.createFolder).not.toHaveBeenCalled();
    expect(app2.vault.create).toHaveBeenCalledTimes(1);
  });

  it('sanitizes unsafe title and folder internally', async () => {
    const { app, ragEngine, createdPaths } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'Bad:Title', folder: 'Bad/../Folder', content: 'x' },
    ];

    const results = await createNotesFromDrafts(drafts, app, ragEngine);

    expect(results[0].status).toBe('created');
    // Path must not contain colon, "..", or double-slash
    expect(results[0].path).not.toContain(':');
    expect(results[0].path).not.toContain('..');
    expect(results[0].path).toBe('Bad/Folder/BadTitle.md');
  });

  it('saves correct markdown content', async () => {
    const { app, ragEngine, createdContents } = setupMocks();
    const drafts: NoteDraft[] = [
      { title: 'Content Test', content: '# Title\n\nBody text with [[links]]' },
    ];

    await createNotesFromDrafts(drafts, app, ragEngine);

    expect(createdContents[0]).toBe('# Title\n\nBody text with [[links]]');
  });
});

// ── MAX_DRAFTS ──

describe('MAX_DRAFTS', () => {
  it('is 10', () => {
    expect(MAX_DRAFTS).toBe(10);
  });
});
