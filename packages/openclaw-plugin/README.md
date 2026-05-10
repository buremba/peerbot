# @lobu/openclaw-plugin

Lobu memory plugin for [OpenClaw](https://openclaw.ai). Gives OpenClaw agents persistent, structured memory over MCP — recall relevant facts before each prompt and capture new observations after each session.

Full install guide: **[lobu.ai/connect-from/openclaw](https://lobu.ai/connect-from/openclaw/)**

## Install

```bash
openclaw plugins install @lobu/openclaw-plugin
```

Then log in and configure against your Lobu memory MCP endpoint:

```bash
lobu login
lobu memory configure --url <mcp-url> --org <org-slug>
lobu memory health --url <mcp-url> --org <org-slug>
```

Replace `<mcp-url>` with your workspace MCP URL (for example `https://lobu.ai/mcp/acme`, or `http://localhost:8787/mcp` for the local runtime). `lobu memory configure` writes a `tokenCommand` that uses `lobu token --raw`, so the plugin reuses the top-level Lobu CLI login.

## Configuration

| Field | Description |
|-------|-------------|
| `mcpUrl` | Full MCP endpoint URL. Required. |
| `webUrl` | Public web URL for the Lobu memory instance. Used to generate links shown to the agent. |
| `token` | Bearer token for MCP requests. Optional — if unset, the plugin runs interactive device login. |
| `tokenCommand` | Shell command that prints a bearer token to stdout. Alternative to `token`. |
| `headers` | Extra HTTP headers for MCP requests. |
| `autoRecall` | Search Lobu memory for relevant memories before each prompt. Default `true`. |
| `recallLimit` | Maximum recalled memory records per request. Default `6`. |
| `autoCapture` | Capture conversation observations as long-term memories after each session. Default `true`. |
| `memoryWikiCompat` | Spike/compat mode. `true` (or `{ enabled: true }`) registers OpenClaw memory-wiki tools (`wiki_status`, `wiki_search`, `wiki_get`, `wiki_apply`, `wiki_lint`) and the `memory_search`/`memory_get` aliases. Default `false`. |

See [`openclaw.plugin.json`](./openclaw.plugin.json) for the full schema.

## Memory-wiki compatibility mode

When `memoryWikiCompat` is enabled the plugin registers an OpenClaw-flavoured tool surface backed by existing Lobu MCP primitives — there is no separate wiki vault, no markdown export, and no MCP contract changes.

| Compat tool | Backed by | Notes |
| --- | --- | --- |
| `wiki_status` | `list_watchers` + `search_memory` probe | Reports `corpus = memory \| wiki \| all`, watcher count, MCP reachability. |
| `wiki_search` | `search_memory`, `read_knowledge` (claim & synthesis), `list_watchers` | `corpus=memory` searches raw Lobu memory; `corpus=wiki` projects claims/syntheses/watchers; `corpus=all` merges both. Short queries (<3 chars) skip `read_knowledge`. |
| `wiki_get` | `read_knowledge`, `get_watcher` | Lookup parser accepts `event:123`, `watcher:7`, `window:9`, `reports/watchers/4` paths, or a free-text query. |
| `wiki_apply` | `save_memory`, `manage_watchers.submit_feedback` | `op=create_synthesis` → `save_memory` with `semantic_type=synthesis`; `op=update_metadata` with `watcher_id`/`window_id`/`corrections` → `manage_watchers.submit_feedback` (corrections must contain `field_path`); otherwise stores a claim event. |
| `wiki_lint` | In-plugin session ring buffer (cap 32) | Warns when `wiki_apply` was called with no evidence, when `status=active` confidence is below `0.5`, and when a wiki/memory search returned zero results. |
| `memory_search`, `memory_get` | `search_memory`, `read_knowledge` | OpenClaw-named aliases. `memory_search` does not route corpus — use `wiki_search` for that. |

`corpus` always means `memory | wiki | all` inside the agent's authenticated Lobu org. It is **not** an org/workspace selector.

### Tracing the compatibility tools against a live Lobu

`scripts/lobu/run-memory-wiki-compat-trace.ts` exercises the compat layer against a running Lobu MCP and emits a markdown comparison alongside the baseline (raw `search_memory`/`read_knowledge`/`list_watchers`) calls:

```bash
LOBU_MCP_URL=http://localhost:8787/mcp/<org-slug> \
LOBU_MCP_TOKEN=$BENCH_TOKEN \
  bun run scripts/lobu/run-memory-wiki-compat-trace.ts
```

The script writes `.lobu/benchmarks/memory/wiki-compat-trace.{md,json}`. It captures tool-surface differences (fan-out, latency, error shape) rather than retrieval recall — the existing retrieval-only benchmark in `packages/server/src/benchmarks/memory/` would show no difference between compat-on and compat-off, since both paths fetch the same underlying records.

## License

BUSL-1.1. See the repository [LICENSE](../../LICENSE).
