# Canonical Owletto Tool Workflows

Use these tool names and patterns. Do not use stale aliases like `search`, `get_content`, or `save_content`.

## Search Before Create

Search first:

```json
{
  "tool": "search_knowledge",
  "arguments": {
    "query": "Spotify",
    "entity_type": "brand"
  }
}
```

If the entity is missing, create it with `manage_entity`, then configure ingestion with `manage_connections`.

## Save Durable Memory

```json
{
  "tool": "save_knowledge",
  "arguments": {
    "kind": "note",
    "title": "User preference",
    "content": "User prefers dark mode and weekly summaries.",
    "metadata": {},
    "entity_ids": [1]
  }
}
```

## Update a Fact (Supersede)

When a fact changes, search for the old one first, then save the replacement with `supersedes_event_id`. The old event is automatically hidden from future searches.

```json
{
  "tool": "save_knowledge",
  "arguments": {
    "kind": "preference",
    "content": "User now prefers light mode.",
    "metadata": {},
    "entity_ids": [1],
    "supersedes_event_id": 42
  }
}
```

## Retrieve Saved Content

Semantic search: pass a `query` to find content by meaning (not just keywords). Uses vector similarity when embeddings are available, falls back to text matching.

```json
{
  "tool": "read_knowledge",
  "arguments": {
    "query": "dark mode preference",
    "entity_id": 1,
    "limit": 5,
    "min_similarity": 0.4
  }
}
```

## Watcher Execution

1. Inspect watcher state with `get_watcher`.
2. Fetch pending content and prompt material with `read_knowledge(watcher_id, since, until)`.
3. Submit the extracted payload with `manage_watchers(action="complete_window")`.

## URL Safety

If the user needs a workspace or entity link, use tool output that already includes the correct URL. Never construct Owletto URLs manually.
