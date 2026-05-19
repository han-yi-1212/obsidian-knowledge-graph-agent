import { requestUrl } from 'obsidian';
import type { KnowledgeGraphAgentSettings, ChatMessage, SearchResult } from './types';

export class DeepSeekAPI {
  private settings: KnowledgeGraphAgentSettings;

  constructor(settings: KnowledgeGraphAgentSettings) {
    this.settings = settings;
  }

  updateSettings(settings: KnowledgeGraphAgentSettings): void {
    this.settings = settings;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.settings.deepseekApiKey}`,
    };
  }

  /**
   * Non-streaming chat completion (used for summarization / context prep).
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.settings.deepseekBaseUrl}/v1/chat/completions`;

    const body = {
      model: this.settings.chatModel,
      messages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      stream: false,
    };

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      throw: true,
    });

    const data = response.json;
    return data.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Streaming chat completion. Calls onToken for each text delta, onDone when finished.
   */
  async chatStream(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    onDone: (fullText: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const url = `${this.settings.deepseekBaseUrl}/v1/chat/completions`;

    const body = {
      model: this.settings.chatModel,
      messages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      stream: true,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader available');
      }

      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              onToken(delta);
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      onDone(fullText);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Build a system prompt augmented with RAG context and user-selected notes.
   */
  buildSystemPrompt(
    searchResults: SearchResult[],
    activeNoteTitle: string | null,
    selectedNotesContent?: { title: string; content: string }[],
  ): string {
    let prompt = `You are a knowledgeable AI assistant integrated into an Obsidian knowledge graph.

You help the user understand and connect their notes. Answer questions based on the provided context when relevant. When you reference a note, use [[note title]] wikilink syntax.

`;

    if (activeNoteTitle) {
      prompt += `The user currently has "${activeNoteTitle}" open.\n`;
    }

    // User-selected notes (highest priority context)
    if (selectedNotesContent && selectedNotesContent.length > 0) {
      prompt += `\n## User-Selected Notes (primary context — prioritize these)\n\n`;
      for (const n of selectedNotesContent) {
        prompt += `### [[${n.title}]]\n${n.content}\n\n`;
      }
    }

    if (searchResults.length > 0) {
      prompt += `\n## Automatically Retrieved Notes\n\n`;
      for (const r of searchResults) {
        prompt += `### [[${r.title}]]\n${r.chunk}\n\n`;
      }
    }

    prompt += `\nAlways strive to make connections between the user's notes. When an answer spans multiple notes, explicitly mention the links between them.`;

    return prompt;
  }
}
