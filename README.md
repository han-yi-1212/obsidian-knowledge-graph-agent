# Knowledge Graph Agent

AI-powered knowledge graph for Obsidian with DeepSeek chat integration. Visualize your note connections and converse with a context-aware AI assistant that searches your vault to ground its answers.

## Features

- **Interactive knowledge graph** — Visualize note links as a force-directed graph. Double-click nodes to open notes, right-click for context menu.
- **AI chat with RAG** — Ask questions about your vault. The plugin retrieves relevant notes and injects them as context, so the AI answers are grounded in your own writing.
- **Two-stage retrieval** — Keyword recall followed by rich-signal reranking (phrase matching, proximity, title weighting) for high-quality search results.
- **Source citations** — Every AI response shows which notes were used, with relevance scores and content previews. Click a source to open the note.
- **Streaming with stop** — Chat replies stream token-by-token via DeepSeek API. Press Stop or Enter to cancel mid-stream.
- **Friendly error handling** — Clear messages for missing API key, invalid key (401), rate limiting (429), and network errors.
- **Context pinning** — Right-click graph nodes to pin notes to the chat context. The AI prioritizes pinned notes when answering.

## Installation

### Manual

1. Download the latest release from [Releases](https://github.com/han-yi-1212/obsidian-knowledge-graph-agent/releases).
2. Extract into your vault's `.obsidian/plugins/knowledge-graph-agent/` directory.
3. Enable the plugin in Obsidian's Community Plugins settings.

### From Source

```bash
git clone https://github.com/han-yi-1212/obsidian-knowledge-graph-agent.git
cd obsidian-knowledge-graph-agent
npm install
npm run build
```

Then copy `main.js`, `styles.css`, and `manifest.json` to your vault's `.obsidian/plugins/knowledge-graph-agent/`.

## Configuration

| Setting | Description | Default |
|---|---|---|
| DeepSeek API Key | Your API key from platform.deepseek.com | — |
| Base URL | API endpoint (supports custom proxies) | `https://api.deepseek.com` |
| Chat Model | Model used for chat | `deepseek-chat` |
| Temperature | Response creativity (0–2) | 0.7 |
| Max Tokens | Maximum response length | 4096 |
| Max Context Chunks | Notes retrieved per query | 10 |
| Chunk Size | Characters per text chunk | 500 |
| Chunk Overlap | Overlap between chunks | 50 |
| Graph Max Nodes | Maximum nodes in the graph | 200 |
| Show Orphans | Display notes with zero links | Off |

## Usage

1. Click the network icon in the left ribbon, or run the "Open Knowledge Graph Agent" command.
2. The left pane shows your knowledge graph. The right pane is the AI chat.
3. **Search nodes** — Type in the toolbar to highlight matching nodes.
4. **Chat** — Type a question and press Enter. The AI searches your vault and answers with citations.
5. **Pin context** — Right-click a graph node and choose "Add to chat context" to pin that note. Pinned notes are prioritized over automatic search results.

## Privacy

- Your notes never leave your computer except for the text chunks sent to the DeepSeek API as part of the chat prompt.
- The API key is stored locally in Obsidian's plugin data.
- No analytics, no telemetry, no third-party servers beyond the API endpoint you configure.

## Development

```bash
npm install         # Install dependencies
npm run dev         # Watch mode for development
npm test            # Run tests (51 tests)
npm run test:watch  # Run tests in watch mode
npm run release:zip # Build and package for distribution
```

## License

MIT
