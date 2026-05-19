import { Modal, App } from 'obsidian';
import type { NoteDraft } from './note-drafts';

type OnConfirm = (selectedDrafts: NoteDraft[]) => void;

export class DraftPreviewModal extends Modal {
  private drafts: NoteDraft[];
  private conflicts: Map<number, string>;
  private onConfirm: OnConfirm;
  private checkboxes: HTMLInputElement[] = [];

  constructor(
    app: App,
    drafts: NoteDraft[],
    conflicts: Map<number, string>,
    onConfirm: OnConfirm,
  ) {
    super(app);
    this.drafts = drafts;
    this.conflicts = conflicts;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kga-draft-preview');

    contentEl.createEl('h3', { text: `Review ${this.drafts.length} note drafts` });

    const list = contentEl.createDiv('kga-draft-list');

    for (let i = 0; i < this.drafts.length; i++) {
      const draft = this.drafts[i];
      const hasConflict = this.conflicts.has(i);

      const item = list.createDiv('kga-draft-item');

      // Checkbox row
      const header = item.createDiv('kga-draft-item-header');

      const cb = header.createEl('input', { type: 'checkbox' });
      cb.checked = true;
      cb.setAttribute('data-index', String(i));
      this.checkboxes.push(cb);

      const titleEl = header.createSpan({
        text: draft.title || '(untitled)',
        cls: 'kga-draft-item-title',
      });

      const pathEl = header.createSpan({
        text: `${draft.folder || 'AI Notes'}/`,
        cls: 'kga-draft-item-folder',
      });
      pathEl.setAttr('title', `Will be created at: ${draft.folder || 'AI Notes'}/${draft.title}.md`);

      // Conflict warning
      if (hasConflict) {
        const warn = item.createDiv('kga-draft-item-conflict');
        warn.setText(`Will rename: ${this.conflicts.get(i)} already exists → auto-suffix -2, -3…`);
      } else {
        const ok = item.createDiv('kga-draft-item-ok');
        ok.setText('OK — no conflicts');
      }

      // Content preview
      const preview = item.createDiv('kga-draft-item-preview');
      preview.setText(
        draft.content.slice(0, 200).replace(/\n/g, ' ') +
        (draft.content.length > 200 ? '…' : ''),
      );
    }

    // Action buttons
    const actions = contentEl.createDiv('kga-draft-actions');

    const createAllBtn = actions.createEl('button', {
      text: 'Create all',
      cls: 'kga-draft-create-all-btn',
    });
    createAllBtn.addEventListener('click', () => {
      this.onConfirm(this.drafts);
      this.close();
    });

    const createSelectedBtn = actions.createEl('button', {
      text: 'Create selected',
      cls: 'kga-draft-create-selected-btn',
    });
    createSelectedBtn.addEventListener('click', () => {
      const selected: NoteDraft[] = [];
      for (let i = 0; i < this.checkboxes.length; i++) {
        if (this.checkboxes[i].checked) {
          selected.push(this.drafts[i]);
        }
      }
      if (selected.length > 0) {
        this.onConfirm(selected);
      }
      this.close();
    });

    const cancelBtn = actions.createEl('button', {
      text: 'Cancel',
      cls: 'kga-draft-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
