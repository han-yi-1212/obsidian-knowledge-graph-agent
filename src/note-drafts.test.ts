import { describe, it, expect, vi } from 'vitest';
import {
  parseDraftsFromResponse,
  sanitizeTitle,
  sanitizeFolder,
  sanitizeDrafts,
  validateDrafts,
  resolvePath,
  checkConflicts,
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

// ── MAX_DRAFTS ──

describe('MAX_DRAFTS', () => {
  it('is 10', () => {
    expect(MAX_DRAFTS).toBe(10);
  });
});
