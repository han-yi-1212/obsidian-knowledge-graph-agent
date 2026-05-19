// Mock Obsidian module for vitest — only exports the symbols used by tests
export class App {}
export class TFile {
  path!: string;
  basename!: string;
  extension!: string;
}
export class Vault {}
export class MetadataCache {}
export class Workspace {}
export class ItemView {}
export class WorkspaceLeaf {}
export class Menu {}
export class Notice {
  constructor(_msg: string) {}
}
export class MarkdownRenderer {
  static render(_app: any, _markdown: string, _container: HTMLElement) {
    return Promise.resolve();
  }
}
