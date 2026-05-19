import type { App, TFile } from 'obsidian';
import type { RAGEngine } from './rag';

export interface NoteDraft {
  title: string;
  folder?: string;
  content: string;
  links?: string[];
}

export interface DraftValidationError {
  index: number;
  field: string;
  message: string;
}

export interface DraftCreateResult {
  draft: NoteDraft;
  path: string;
  status: 'created' | 'renamed' | 'skipped' | 'error';
  originalPath?: string;
  error?: string;
}

const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
const MAX_DRAFTS = 10;

/**
 * Resolve the full vault path for a draft.
 * Default folder is "AI Notes".
 */
export function resolvePath(draft: NoteDraft): string {
  const folder = (draft.folder || 'AI Notes').replace(/^\/+|\/+$/g, '');
  const safeName = draft.title.replace(ILLEGAL_CHARS, '').trim() || 'Untitled';
  return `${folder}/${safeName}.md`;
}

/**
 * Extract a NoteDraft array from an AI response that may contain
 * explanatory text around the JSON.
 *
 * Tries in order:
 *  1. ```
json … ```
 code fence
 *  2. First balanced { … } JSON block (scans for outermost braces)
 *
 * Returns null if no valid JSON with a "notes" array is found.
 */
export function parseDraftsFromResponse(text: string): NoteDraft[] | null {
  let jsonStr: string | null = null;

  // Strategy 1: markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Strategy 2: outermost balanced braces
  if (!jsonStr) {
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      let lastBrace = -1;
      for (let i = firstBrace; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            lastBrace = i;
            break;
          }
        }
      }
      if (lastBrace !== -1) {
        jsonStr = text.slice(firstBrace, lastBrace + 1);
      }
    }
  }

  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && Array.isArray(parsed.notes)) {
      const drafts: NoteDraft[] = [];
      for (const item of parsed.notes) {
        if (item && typeof item.title === 'string' && typeof item.content === 'string') {
          drafts.push({
            title: String(item.title).trim(),
            folder: item.folder ? String(item.folder).trim() : undefined,
            content: String(item.content),
            links: Array.isArray(item.links) ? item.links.map(String) : undefined,
          });
        }
      }
      return drafts.length > 0 ? drafts : null;
    }
  } catch {
    // JSON parse failed — not a valid draft response
  }

  return null;
}

/**
 * Validate drafts. Returns errors for:
 *  - empty title
 *  - illegal filename characters
 *  - empty content
 *  - exceeding maxCount
 */
export function validateDrafts(
  drafts: NoteDraft[],
  maxCount = MAX_DRAFTS,
): DraftValidationError[] {
  const errors: DraftValidationError[] = [];

  if (drafts.length > maxCount) {
    errors.push({
      index: -1,
      field: 'count',
      message: `Too many drafts: ${drafts.length} (max ${maxCount}). Only the first ${maxCount} will be used.`,
    });
  }

  const effective = drafts.slice(0, maxCount);

  for (let i = 0; i < effective.length; i++) {
    const d = effective[i];
    if (!d.title || !d.title.trim()) {
      errors.push({ index: i, field: 'title', message: 'Title is required.' });
    } else if (ILLEGAL_CHARS.test(d.title)) {
      errors.push({
        index: i,
        field: 'title',
        message: `Title contains illegal characters: ${d.title.match(ILLEGAL_CHARS)?.join(' ')}`,
      });
    }

    if (!d.content || !d.content.trim()) {
      errors.push({ index: i, field: 'content', message: 'Content is required.' });
    }
  }

  return errors;
}

/**
 * Check which drafts would conflict with existing files.
 * Returns a Map of draft index → existing file path.
 */
export function checkConflicts(
  drafts: NoteDraft[],
  app: App,
): Map<number, string> {
  const conflicts = new Map<number, string>();

  for (let i = 0; i < drafts.length; i++) {
    const targetPath = resolvePath(drafts[i]);
    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
      conflicts.set(i, targetPath);
    }
  }

  return conflicts;
}

/**
 * Batch-create notes from validated drafts.
 *
 * - Automatically deduplicates: if resolvePath collides, appends " -2", " -3", etc.
 * - Calls ragEngine.indexFile() for each successfully created note.
 * - Does NOT throw — individual failures are captured in the result array.
 */
export async function createNotesFromDrafts(
  drafts: NoteDraft[],
  app: App,
  ragEngine: RAGEngine,
): Promise<DraftCreateResult[]> {
  const results: DraftCreateResult[] = [];

  for (const draft of drafts) {
    let targetPath = resolvePath(draft);

    try {
      // Dedup: append -2, -3… if file already exists
      let suffix = 2;
      const folder = (draft.folder || 'AI Notes').replace(/^\/+|\/+$/g, '');
      const baseName = draft.title.replace(ILLEGAL_CHARS, '').trim() || 'Untitled';
      let fileName = baseName;
      while (app.vault.getAbstractFileByPath(`${folder}/${fileName}.md`)) {
        fileName = `${baseName} - ${suffix}`;
        suffix++;
      }
      targetPath = `${folder}/${fileName}.md`;

      // Ensure folder exists
      const existingFolder = app.vault.getAbstractFileByPath(folder);
      if (!existingFolder) {
        await app.vault.createFolder(folder);
      }

      const file = await app.vault.create(targetPath, draft.content);
      await ragEngine.indexFile(file);

      results.push({
        draft,
        path: targetPath,
        status: fileName !== baseName ? 'renamed' : 'created',
        originalPath: fileName !== baseName ? resolvePath(draft) : undefined,
      });
    } catch (err) {
      results.push({
        draft,
        path: targetPath,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Build a human-readable summary of batch creation results,
 * suitable for displaying in the chat view.
 */
export function summarizeResults(results: DraftCreateResult[]): string {
  const created = results.filter(r => r.status === 'created').length;
  const renamed = results.filter(r => r.status === 'renamed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (renamed > 0) parts.push(`${renamed} renamed (duplicate names)`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (errors > 0) parts.push(`${errors} failed`);

  let summary = `## 📝 Notes Created\n\n${parts.join(', ')}.\n\n`;

  for (const r of results) {
    const icon = r.status === 'created' ? '✅' :
      r.status === 'renamed' ? '🔄' :
      r.status === 'error' ? '❌' : '⏭️';
    summary += `- ${icon} **[[${r.draft.title}]]**`;
    if (r.status === 'renamed') summary += ` (renamed from \`${r.draft.title}.md\`)`;
    if (r.status === 'error') summary += ` — ${r.error}`;
    summary += '\n';
  }

  return summary;
}
