# Knowledge Graph Agent

> Obsidian plugin — visualize your notes as an interactive knowledge graph and chat with AI that understands your vault.

[中文](./README_CN.md)

## Features

### Knowledge Graph
- **Force-directed layout** — Cytoscape.js renders `[[wikilinks]]` as an interactive graph. Node size reflects total link count (outgoing + backlinks).
- **Node search** — Type in the toolbar to highlight matching nodes and dim the rest.
- **Node interactions** — Double-click opens the note. Right-click shows a context menu (Open, Open in new pane, Add to chat context).
- **Large vault ready** — Pre-built `Map`/`Set` for O(1) lookups and deduplication. Refresh stays responsive even with hundreds of notes.
- **Configurable** — Cap nodes with `Graph Max Nodes`. Toggle orphan visibility with `Show Orphans`.

### AI Chat
- **RAG-powered** — Every question triggers a vault search. Relevant notes are injected into the AI context so answers are grounded in your own writing.
- **Two-stage retrieval** — Keyword recall (TF-IDF) followed by rich-signal reranking (phrase matching, token proximity, title weighting).
- **Streaming** — Responses stream token-by-token via the DeepSeek API.
- **Stop / Cancel** — Click Stop or press Enter to abort mid-stream at any time.

### Source Citations
- Collapsible `📚 Sources` section appears below every AI response.
- **📌 Pinned** — Manually added notes show a Pinned badge. The AI prioritizes these.
- **🔍 Retrieved** — Automatically matched notes show a normalized relevance percentage (0%–100%) and content snippet.
- Click any note name to open it directly.

### Save to Note
- Each AI response has action buttons below it:
  - **💾 Save to note** — Creates a new note in `AI Responses/` with the question, full response, and source citations. File name is slugified from the question. Duplicates auto-increment (`-2`, `-3`…).
  - **↩ Insert into active note** — Inserts the response (with sources) at the current cursor position in the currently open note.
  - **📎 Append to active note** — Appends the response to the end of the currently open note.
- Command **"Save last AI response to note"** saves the most recent AI reply without clicking a button.

### Draft Notes (Batch Creation)
- **📝 Draft mode toggle** — Click the 📝 button next to the chat input to enter draft mode. The AI will generate structured note drafts as JSON.
- **Plan → Preview → Confirm** — Describe what notes you want (e.g. "Create 5 atomic notes from my knowledge management research"). The AI returns a list of drafts. A preview modal shows each title, target folder, content snippet, and any file name conflicts.
- **Select and create** — Check/uncheck individual drafts. Click **Create all** or **Create selected**. Notes are created in the target folder (default `AI Notes/`). Duplicate names auto-increment (`-2`, `-3`…).
- **Safe by design** — The AI never writes files directly. The plugin validates every draft, shows you exactly what will be created, and only creates files after you confirm.
- New notes are automatically indexed into the RAG engine for future searches.

### Context Management
- Right-click a graph node → Add to chat context.
- Click a context badge to remove it.
- The currently open note is automatically tracked as context.

### Index Lifecycle
- **Progress display** — Shows `Indexing 45/120 files…` on startup. Chat input is disabled until indexing completes.
- **File watchers** — Create, modify, delete, and rename events update the index incrementally.
- **Dirty file tracking** — Edits made during a full rebuild are not lost; they are re-indexed after the build finishes.
- **Hot settings** — Changing Chunk Size or Chunk Overlap triggers an automatic rebuild without restarting.

### Error Handling
- Missing API key → prompts you to configure one in settings
- Invalid key (401) → suggests checking or regenerating your key
- Rate limited (429) → asks you to wait and retry
- Network failure → suggests checking your connection and Base URL

## Installation

### From Release

1. Download `obsidian-knowledge-graph-agent.zip` from [Releases](https://github.com/han-yi-1212/obsidian-knowledge-graph-agent/releases).
2. Extract into your vault's `.obsidian/plugins/knowledge-graph-agent/` directory.
3. Enable the plugin in Obsidian → Settings → Community Plugins.

### From Source

```bash
git clone https://github.com/han-yi-1212/obsidian-knowledge-graph-agent.git
cd obsidian-knowledge-graph-agent
npm install
npm run build        # Compile the plugin
npm run release:zip  # Package for distribution
```

Copy `main.js`, `styles.css`, and `manifest.json` into `.obsidian/plugins/knowledge-graph-agent/`.

## Settings

| Setting | Description | Default |
|---|---|---|
| **DeepSeek API Key** | Your API key from [platform.deepseek.com](https://platform.deepseek.com) | — |
| **Base URL** | API endpoint (supports custom proxies) | `https://api.deepseek.com` |
| **Chat Model** | Model used for chat | `deepseek-chat` |
| **Temperature** | Response creativity (0 = precise, 2 = creative) | 0.7 |
| **Max Tokens** | Maximum response length | 4096 |
| **Max Context Chunks** | Retrieved note snippets per query | 10 |
| **Chunk Size** | Characters per text chunk (triggers reindex) | 500 |
| **Chunk Overlap** | Overlap between adjacent chunks (triggers reindex) | 50 |
| **Graph Max Nodes** | Maximum visible graph nodes | 200 |
| **Show Orphans** | Display notes with zero links | Off |

## Usage

### Basic Workflow

1. Click the 🕸️ ribbon icon or run `Open Knowledge Graph Agent`.
2. Left pane: knowledge graph. Right pane: AI chat.
3. Type your question and press Enter to send.
4. The AI searches your vault, injects relevant notes as context, and responds with citations.

### Graph Controls

| Action | Result |
|---|---|
| Double-click node | Open the note |
| Right-click node | Context menu (Open / Open in new pane / Add to chat) |
| Toolbar search | Highlight matching nodes |
| Refresh button | Rebuild graph from vault data |
| Fit button | Zoom to fit all nodes |

### Chat Tips

- **Ask direct questions** — "What are the gaps in my knowledge management system?" The AI answers based on your vault.
- **Pin context first** — Right-click a few key notes to pin them, then ask. The AI will prioritize those notes.
- **Cross-note connections** — "How do A and B relate to each other?" The AI analyzes links across your notes.
- **Stop anytime** — Press Stop or Enter during streaming to cancel. Partial output is preserved.
- **Save good responses** — Click **💾 Save to note** to capture the answer as a permanent note, or **📎 Append** to add it to your daily note.
- **Batch draft notes** — Click **📝** then describe the notes you want. The AI generates structured drafts, you review and confirm, then they're created in bulk.

### Reading Source Citations

Each AI response has a `📚 Sources` section below it:

- Click the summary bar to expand/collapse the detail list.
- **📌 Pinned Notes** — Your manually selected context (highest priority).
- **🔍 Retrieved Notes** — Automatically matched from your vault.
- Each item shows the note name (clickable) and a relevance score or Pinned label.
- Content snippets show the actual text that was matched.

## Privacy & Security

- Your notes leave your device only as text chunks sent to the DeepSeek API during chat.
- The API key is stored in Obsidian's local plugin data.
- No analytics, no telemetry, no third-party servers beyond the configured API endpoint.
- All index data lives in memory and is lost when Obsidian closes.

## Development

```bash
npm install         # Install dependencies
npm run dev         # Watch mode for development
npm test            # Run tests (51 tests)
npm run test:watch  # Watch mode for tests
npm run build       # Production build
npm run release:zip # Build and package for distribution
```

### Project Structure

```
├── main.ts                  # Plugin entry point, lifecycle management
├── src/
│   ├── api.ts               # DeepSeek API client (streaming + non-streaming)
│   ├── chat-view.ts         # Chat panel view
│   ├── graph-view.ts        # Knowledge graph view (Cytoscape.js)
│   ├── rag.ts               # RAG engine (index management + state machine)
│   ├── retrieval.ts         # Pure retrieval functions (tokenize / chunk / search / rerank)
│   ├── retrieval.test.ts    # Retrieval tests (36)
│   ├── rag.test.ts          # Index lifecycle tests (15)
│   ├── settings.ts          # Settings tab
│   ├── types.ts             # Type definitions
│   └── __mocks__/
│       └── obsidian.ts      # Obsidian API mock for tests
├── styles.css               # UI styles
├── manifest.json            # Obsidian plugin manifest
└── versions.json            # BRAT version compatibility map
```

## Known Limitations

- Embedding-based semantic search is not yet implemented (current approach: keyword + rerank).
- Graph layout can be slow with >500 nodes.
- Chat history is session-only and lost on Obsidian restart.
- Only DeepSeek API is supported (single provider).

## License

MIT
