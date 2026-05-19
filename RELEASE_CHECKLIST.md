# Release Checklist — Knowledge Graph Agent v0.1.0

## Before Testing

- [ ] `npm test` — all 51 tests pass
- [ ] `npm run build` — TypeScript clean, esbuild produces `main.js`
- [ ] `npm run release:zip` — produces `release/obsidian-knowledge-graph-agent.zip` with exactly 3 files: `main.js`, `styles.css`, `manifest.json`

## Test Environments

Test in each vault scenario:

### 1. New / Empty Vault (0 notes)

- [ ] Plugin loads without errors
- [ ] Knowledge graph shows "no nodes" or empty state
- [ ] Chat input is disabled until index completes (instant — 0 chunks)
- [ ] Chat works: ask a general question, AI replies without RAG context
- [ ] No graph nodes to interact with — no crashes

### 2. Small Vault (5–20 notes, some with `[[links]]`)

- [ ] Graph renders with nodes and edges
- [ ] Double-click node → opens note
- [ ] Right-click node → context menu (Open, Open in new pane, Add to chat)
- [ ] "Add to chat context" → pin badge appears, AI prioritizes it
- [ ] Search nodes in toolbar → highlights matching nodes, dims others
- [ ] Refresh → graph re-renders, links resolve correctly
- [ ] Fit → zooms to show all nodes
- [ ] Click pinned chip in context bar → removes from context

### 3. Large Vault (200+ notes)

- [ ] Graph caps at `graphMaxNodes` setting (default 200)
- [ ] Indexing shows progress ("Indexing 120/500 files…")
- [ ] Chat input disabled during indexing, enabled when ready
- [ ] Bottom bar shows "Index: N chunks" after indexing
- [ ] Refresh graph responds within 1-2 seconds (Map/Set O(1) fix)
- [ ] Search results return relevant notes, not random ones

### 4. No API Key Configured

- [ ] Chat input enabled (index is ready)
- [ ] Send a message → Notice appears "Please configure your DeepSeek API Key"
- [ ] Chat message shows friendly error, not raw stack trace
- [ ] No crash in console

### 5. Invalid API Key (401)

- [ ] Configure a fake API key
- [ ] Send a message → Notice "Invalid API Key (401)"
- [ ] Chat message shows actionable guidance ("regenerate at platform.deepseek.com")
- [ ] Can still send follow-up messages

### 6. Network Error / Wrong Base URL

- [ ] Set Base URL to `https://localhost:9999` (nothing listening)
- [ ] Send a message → Notice "Network error"
- [ ] Chat message shows connection guidance
- [ ] Restore correct Base URL → chat works again

### 7. Rate Limiting (429)

- [ ] (If possible) trigger rate limit by rapid sending
- [ ] Notice shows "Rate limited... try again later"
- [ ] App doesn't crash

## Streaming & Interaction

### 8. Streaming Response

- [ ] Response appears token-by-token in real time
- [ ] Wikilinks `[[note name]]` in response are clickable
- [ ] Markdown formatting (bold, code blocks) renders correctly
- [ ] Scroll follows content ("auto-scroll to bottom")

### 9. Stop / Cancel

- [ ] Send a message → Stop button appears (red), Send button hidden
- [ ] Click Stop → streaming stops, partial text shown (if any)
- [ ] Stop button hidden, Send button reappears
- [ ] Can immediately send another message after stopping
- [ ] Stop during API error (network failure) works without crash

### 10. Source Citations

- [ ] After AI reply, "📚 Sources: X Retrieved" section appears below
- [ ] Click summary bar → source list expands/collapses
- [ ] Pinned notes show "📌 Pinned" badge
- [ ] Retrieved notes show percentage scores (0%–100%, never >100%)
- [ ] Click note name in sources → opens the note
- [ ] Content snippet shows actual note text (first 200 chars)

### 11. Multi-turn Conversation

- [ ] Chat history persists across messages in a session
- [ ] Follow-up questions reference prior context
- [ ] History trimmed at 40 messages (no context overflow error)

## Index Lifecycle

### 12. Settings Change Triggers Rebuild

- [ ] Change Chunk Size in settings → "Indexing vault…" appears
- [ ] Chat input disabled during rebuild
- [ ] After rebuild, bottom bar updates with new chunk count
- [ ] Change multiple settings rapidly → only one rebuild in progress, queue resolves

### 13. File Watchers

- [ ] Create a new note with content → appears in index (searchable)
- [ ] Modify a note → search reflects new content
- [ ] Delete a note → search no longer returns that note
- [ ] Rename a note → note still indexed under new name

## Source Citation Accuracy

### 14. Search Retrieval Quality

- [ ] Ask a domain question → sources show relevant notes at top
- [ ] Ask a question unrelated to vault content → fewer sources, AI answers from general knowledge
- [ ] Pinned notes appear first in sources list with "📌 Pinned" section header

## Window & Layout

### 15. Open / Close / Reopen

- [ ] Run "Open Knowledge Graph Agent" command → both panels open
- [ ] Close right sidebar → chat view closes
- [ ] Re-open → chat history preserved (same session), graph re-renders
- [ ] Plugin unload/reload → no stale subscriptions, no memory leak

### 16. Resize

- [ ] Resize chat sidebar → input and messages adapt
- [ ] Resize graph panel → Cytoscape canvas resizes

## Error Recovery

- [ ] Trigger API error → can still type and send new messages
- [ ] Trigger API error during indexing → don't lose control
- [ ] Clear chat mid-stream → streaming aborted cleanly

---

## Release Notes Template

```
v0.1.0 — Alpha Release

New:
- Interactive knowledge graph with search, zoom, context menu
- AI chat with two-stage RAG retrieval (keyword + rerank)
- Source citations with Pinned/Retrieved labels and relevance scores
- Streaming responses with stop/cancel
- Index lifecycle management with progress UI
- Friendly error messages for API key, network, rate limit

Known Limitations:
- Embedding-based semantic search not yet implemented
- Graph layout can be slow for >500 nodes
- No persistent chat history across Obsidian restarts
```
