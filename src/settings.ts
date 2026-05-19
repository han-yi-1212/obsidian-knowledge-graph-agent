import { App, PluginSettingTab, Setting } from 'obsidian';
import type KnowledgeGraphAgentPlugin from '../main';
import type { KnowledgeGraphAgentSettings } from './types';

export class KnowledgeGraphAgentSettingTab extends PluginSettingTab {
  plugin: KnowledgeGraphAgentPlugin;

  constructor(app: App, plugin: KnowledgeGraphAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Knowledge Graph Agent Settings' });

    // ── DeepSeek API ──
    containerEl.createEl('h3', { text: 'DeepSeek API Configuration' });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your DeepSeek API key (stored locally in your vault)')
      .addText(text => text
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.deepseekApiKey)
        .onChange(async (value) => {
          this.plugin.settings.deepseekApiKey = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('API endpoint base URL (default: https://api.deepseek.com)')
      .addText(text => text
        .setPlaceholder('https://api.deepseek.com')
        .setValue(this.plugin.settings.deepseekBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.deepseekBaseUrl = value.trim().replace(/\/$/, '');
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chat Model')
      .setDesc('Model to use for chat completions')
      .addDropdown(dropdown => dropdown
        .addOption('deepseek-v4-pro', 'DeepSeek V4 Pro')
        .addOption('deepseek-chat', 'DeepSeek Chat (V3)')
        .addOption('deepseek-reasoner', 'DeepSeek Reasoner (R1)')
        .setValue(this.plugin.settings.chatModel)
        .onChange(async (value) => {
          this.plugin.settings.chatModel = value;
          await this.plugin.saveSettings();
        }));

    // ── Model Parameters ──
    containerEl.createEl('h3', { text: 'Model Parameters' });

    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('Controls randomness (0 = deterministic, 1 = creative)')
      .addSlider(slider => slider
        .setLimits(0, 2, 0.1)
        .setValue(this.plugin.settings.temperature)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.temperature = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max Tokens')
      .setDesc('Maximum tokens per response')
      .addSlider(slider => slider
        .setLimits(512, 8192, 256)
        .setValue(this.plugin.settings.maxTokens)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTokens = value;
          await this.plugin.saveSettings();
        }));

    // ── RAG Settings ──
    containerEl.createEl('h3', { text: 'Knowledge Retrieval (RAG)' });

    new Setting(containerEl)
      .setName('Chunk Size')
      .setDesc('Target character count per text chunk (changing this rebuilds the index)')
      .addSlider(slider => slider
        .setLimits(200, 2000, 50)
        .setValue(this.plugin.settings.chunkSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.chunkSize = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chunk Overlap')
      .setDesc('Character overlap between adjacent chunks (changing this rebuilds the index)')
      .addSlider(slider => slider
        .setLimits(0, 300, 10)
        .setValue(this.plugin.settings.chunkOverlap)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.chunkOverlap = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Context Chunks')
      .setDesc('Number of relevant text chunks to include in each conversation turn')
      .addSlider(slider => slider
        .setLimits(1, 20, 1)
        .setValue(this.plugin.settings.maxContextChunks)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxContextChunks = value;
          await this.plugin.saveSettings();
        }));

    // ── Graph Settings ──
    containerEl.createEl('h3', { text: 'Graph Display' });

    new Setting(containerEl)
      .setName('Max Nodes')
      .setDesc('Maximum nodes to display in the graph (for performance)')
      .addSlider(slider => slider
        .setLimits(50, 500, 50)
        .setValue(this.plugin.settings.graphMaxNodes)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.graphMaxNodes = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show Orphan Nodes')
      .setDesc('Show notes with no incoming or outgoing links')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.graphShowOrphans)
        .onChange(async (value) => {
          this.plugin.settings.graphShowOrphans = value;
          await this.plugin.saveSettings();
        }));
  }
}
