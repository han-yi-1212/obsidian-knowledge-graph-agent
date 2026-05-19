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

export interface DraftSanitizeWarning {
  index: number;
  field: string;
  original: string;
  cleaned: string;
}

export interface DraftCreateResult {
  draft: NoteDraft;
  path: string;
  status: 'created' | 'renamed' | 'skipped' | 'error';
  originalPath?: string;
  error?: string;
}

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const SEGMENT_ILLEGAL = /[\\/:*?"<>|]/g;
export const MAX_DRAFTS = 10;

/**
 * Sanitize a file name segment — strip illegal chars, collapse whitespace.
 */
function sanitizeSegment(seg: string): string {
  return seg.replace(SEGMENT_ILLEGAL, '').replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize a folder path. Each segment is cleaned; "." and ".." are removed.
 * Returns the sanitized path or "AI Notes" as default.
 */
export function sanitizeFolder(raw: string | undefined): string {
  if (!raw) return 'AI Notes';

  const segments = raw.replace(/\\/g, '/').split('/');
  const cleaned = segments
    .map(s => sanitizeSegment(s))
    .filter(s => s.length > 0 && s !== '.' && s !== '..');

  return cleaned.length > 0 ? cleaned.join('/') : 'AI Notes';
}

/**
 * Sanitize a note title — strip illegal filename chars.
 * Returns the cleaned title or "Untitled".
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(ILLEGAL_CHARS, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

/**
 * Sanitize all drafts and return cleaned copies + warnings about what changed.
 */
export function sanitizeDrafts(drafts: NoteDraft[]): {
  cleaned: NoteDraft[];
  warnings: DraftSanitizeWarning[];
} {
  const cleaned: NoteDraft[] = [];
  const warnings: DraftSanitizeWarning[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];

    const cleanTitle = sanitizeTitle(d.title);
    if (cleanTitle !== d.title) {
      warnings.push({ index: i, field: 'title', original: d.title, cleaned: cleanTitle });
    }

    const cleanFolder = sanitizeFolder(d.folder);
    if (cleanFolder !== (d.folder || 'AI Notes')) {
      warnings.push({ index: i, field: 'folder', original: d.folder || 'AI Notes', cleaned: cleanFolder });
    }

    cleaned.push({ ...d, title: cleanTitle, folder: cleanFolder });
  }

  return { cleaned, warnings };
}

/**
 * Resolve the full vault path for a sanitized draft.
 */
export function resolvePath(draft: NoteDraft): string {
  const folder = sanitizeFolder(draft.folder);
  return `${folder}/${draft.title}.md`;
}

/**
 * Extract a NoteDraft array from an AI response that may contain
 * explanatory text around the JSON.
 *
 * Tries in order:
 *  1. ```json … ``` code fence
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
 * Validate drafts for blocking issues only:
 *  - empty title after sanitization
 *  - empty content
 *
 * Illegal filename chars and folder safety are handled by sanitizeDrafts().
 * Callers should truncate to maxCount before calling this.
 */
export function validateDrafts(drafts: NoteDraft[]): DraftValidationError[] {
  const errors: DraftValidationError[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d.title || !sanitizeTitle(d.title)) {
      errors.push({ index: i, field: 'title', message: 'Title is required.' });
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
 * Create nested folders recursively. Idempotent — skips existing segments.
 */
async function ensureFolderPath(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split('/').filter(s => s.length > 0);
  let current = '';

  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
    }
  }
}

/**
 * Batch-create notes from sanitized, validated drafts.
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
    try {
      const folder = sanitizeFolder(draft.folder);
      const baseName = draft.title;

      // Dedup: append -2, -3… if file already exists
      let fileName = baseName;
      let suffix = 2;
      while (app.vault.getAbstractFileByPath(`${folder}/${fileName}.md`)) {
        fileName = `${baseName} - ${suffix}`;
        suffix++;
      }
      const targetPath = `${folder}/${fileName}.md`;

      await ensureFolderPath(app, folder);

      const file = await app.vault.create(targetPath, draft.content);
      await ragEngine.indexFile(file);

      results.push({
        draft,
        path: targetPath,
        status: fileName !== baseName ? 'renamed' : 'created',
        originalPath: fileName !== baseName ? `${folder}/${baseName}.md` : undefined,
      });
    } catch (err) {
      results.push({
        draft,
        path: resolvePath(draft),
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

  let summary = `## Notes Created\n\n${parts.join(', ')}.\n\n`;

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
