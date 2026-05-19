# qmsum-demo

A Lobu example project that ingests the [QMSum dataset](https://github.com/Yale-LILY/QMSum) (Yale-LILY query-based meeting summarization benchmark) and exposes it as memory to any MCP-capable client (Claude Desktop, Cursor, Claude Code). Evals are run with [promptfoo](https://www.promptfoo.dev) via [`@lobu/promptfoo-provider`](../../packages/promptfoo-provider).

## What this shows

1. A **custom connector** parsing a labeled academic dataset into structured Lobu events with per-domain entity rules — useful as a template for any "shape a static corpus into memory" task.
2. **MCP-exposed org memory.** Connect Claude Desktop / Cursor to this Lobu org and any agent the user already trusts becomes meeting-aware. No re-ingestion across clients.
3. **promptfoo evals against a real Lobu agent** — answer quality vs gold, summary vs gold, speaker attribution. Retrieval-recall is wired but blocked on a gateway change (see [Known limitations](#known-limitations)).

## Prereqs

- Node 22+, Bun, Postgres (with `pgvector`).
- A QMSum checkout in `./data/qmsum`:
  ```bash
  git clone https://github.com/Yale-LILY/QMSum.git data/qmsum
  ```
- A `.env` based on `.env.example` (`ANTHROPIC_API_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`, `LOBU_TOKEN`).

## Bring it up

```bash
# 1. Apply the project — creates the org, entity types, connector + agent.
lobu apply

# 2. Sync the connector — reads data/qmsum/data/* and emits speaker-turn events.
#    Default config: 10 meetings/domain (30 total). Bump per_domain_limit in
#    connectors/qmsum.yaml to ingest more.
lobu sync qmsum-transcripts

# 3. Mint an API token for the eval provider + MCP clients.
export LOBU_TOKEN=$(lobu token)
```

## Run evals

```bash
bun install
bun run prepare-fixtures   # build .eval-fixtures/*.jsonl from QMSum
bun run evals              # promptfoo eval
bun run evals:view         # open the comparison grid in the browser
```

The grid is also a demo asset — screen-share it to walk through pass rates by suite.

## Connect a friend's MCP client

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "lobu-qmsum": {
      "command": "npx",
      "args": ["-y", "@lobu/mcp-client", "--gateway", "http://localhost:8787", "--agent", "qmsum"],
      "env": {
        "LOBU_TOKEN": "<paste from `lobu token`>"
      }
    }
  }
}
```

Cursor: the same JSON in the MCP settings panel. Then ask any natural-language question grounded in the corpus — the agent uses `search_memory` to ground answers in events and cites them with `meeting_id` + `turn_idx` ranges.

## Demo script

1. **Grounded specific Q&A.** Ask: *"What did Grad B say about the structure of the belief net in Bed003?"* Agent retrieves events, answers with `[Bed003 turns 137–150]` citation. Open the Lobu admin UI and click the cited turns to show the exact source.

2. **Cross-client beat (customer audience).** Connect Cursor with the same config above. Ask the same kind of question. Same Lobu org, same memory, same citations, zero re-ingestion. The point: any agent the user already trusts becomes org-aware.

3. **Failure-analysis beat (ML audience).** Pick one known miss case (an Academic specific-query where retrieval gets the wrong context). Show the retrieved events transparently, compare to the gold answer, attribute the failure to short / context-less per-turn embeddings. A credible miss is more useful than a cherry-picked win.

## Data model

- **Entities:** `meeting`, `speaker`. Topic is metadata on each event, not an entity (cross-topic queries aren't worth a separate entity type today).
- **Events:** one per merged speaking turn (consecutive same-speaker turns joined). Carries `meeting_id`, `domain`, `speaker_label`, `turn_idx_start`, `turn_idx_end`, optional `topic_slug`.
- **Speaker identity is per-domain:**

  | Domain | Speaker scope | Reason |
  | --- | --- | --- |
  | Academic | per-meeting | `Grad A/B/C/D` are anonymous per-file codes |
  | Product | per-domain | `Industrial Designer` etc. recur across all AMI meetings |
  | Committee | per-domain | Real persistent names like `Barry Hughes` |

## Known limitations

- **Retrieval-recall and context-* assertions are blocked** on the gateway emitting `tool_use` SSE events. Without that, `@lobu/promptfoo-provider` has no `metadata.toolCalls` / `metadata.retrievedContext` to feed into promptfoo's RAG-specific assertions. The scenario is included in `promptfooconfig.yaml` commented-out for when the gateway change lands. See `packages/promptfoo-provider/README.md` for the full story.

- **No timestamps in QMSum** — every event uses ingest time for `occurred_at`. Don't rely on temporal queries against this corpus.

- **30 meetings** is the default cap. Scale via `per_domain_limit` in `connectors/qmsum.yaml`; expect minutes-of-ingest per extra 30, dominated by embeddings.

## License

Project files: BUSL-1.1 (matches the rest of the Lobu repo). QMSum data is released by Yale-LILY under their own terms — see [their repo](https://github.com/Yale-LILY/QMSum).
