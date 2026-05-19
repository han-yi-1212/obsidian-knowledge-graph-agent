import { requestUrl } from 'obsidian';
import type { KnowledgeGraphAgentSettings, ChatMessage, SearchResult } from './types';

// Sentinels for structured error handling — the caller maps these to user-facing messages.
export const API_ERROR_CODES = {
  KEY_MISSING: 'API_KEY_MISSING',
  KEY_INVALID: 'API_KEY_INVALID',
  RATE_LIMITED: 'API_RATE_LIMITED',
  NETWORK: 'API_NETWORK_ERROR',
} as const;

export function apiErrorMessage(code: string): string {
  switch (code) {
    case API_ERROR_CODES.KEY_MISSING:
      return 'Please configure your DeepSeek API Key in plugin settings.';
    case API_ERROR_CODES.KEY_INVALID:
      return 'Invalid API Key (401). Check your key in plugin settings or regenerate it at platform.deepseek.com.';
    case API_ERROR_CODES.RATE_LIMITED:
      return 'Rate limited by DeepSeek API (429). Please wait a moment and try again.';
    case API_ERROR_CODES.NETWORK:
      return 'Network error — check your internet connection and the Base URL in plugin settings.';
    default:
      return `API request failed. ${code}`;
  }
}

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
   * Streaming chat completion.
   *
   * @param signal — pass an AbortSignal to allow cancellation mid-stream.
   *                 When aborted, onDone is called with whatever text was collected so far.
   */
  async chatStream(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    onDone: (fullText: string) => void,
    onError: (err: Error, code?: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    // Guard: no API key configured
    if (!this.settings.deepseekApiKey) {
      onError(new Error('API key not configured'), API_ERROR_CODES.KEY_MISSING);
      return;
    }

    const url = `${this.settings.deepseekBaseUrl}/v1/chat/completions`;

    const body = {
      model: this.settings.chatModel,
      messages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      stream: true,
    };

    let fullText = '';

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(API_ERROR_CODES.KEY_INVALID);
        }
        if (response.status === 429) {
          throw new Error(API_ERROR_CODES.RATE_LIMITED);
        }
        throw new Error(`API error ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader available');
      }

      const decoder = new TextDecoder();
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
      // Aborted mid-stream — finish gracefully with partial text
      if (err instanceof DOMException && err.name === 'AbortError') {
        onDone(fullText);
        return;
      }

      // Already a structured error code
      if (err instanceof Error && Object.values(API_ERROR_CODES).includes(err.message as any)) {
        onError(err, err.message);
        return;
      }

      // Network / fetch errors
      const isNetworkError =
        err instanceof TypeError ||
        (err instanceof Error && err.message.includes('fetch'));

      if (isNetworkError) {
        onError(new Error('Network error'), API_ERROR_CODES.NETWORK);
      } else {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
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
