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

> **MCP surface note.** Watcher and knowledge admin operations (`list_watchers`, `get_watcher`, `read_knowledge`, `manage_watchers`) are registered as `INTERNAL_REST_TOOLS` in Lobu and **not** exposed on the MCP wire (`internal: true` hides them from `tools/list`). The compatibility layer therefore reaches those capabilities by scripting over the ClientSDK via the two MCP tools that *are* exposed for sandboxed execution: `query_sdk` (read-only) and `run_sdk` (writes). The sandbox requires `isolated-vm` in the host process — if it isn't installed, `query_sdk` returns `{ success: false, error: { name: 'RuntimeUnavailable', ... } }` and this layer surfaces it to the agent as a clear error instead of returning empty results.

| Compat tool | Backed by | Notes |
| --- | --- | --- |
| `wiki_status` | `query_sdk` (`client.watchers.list`) + `search_memory` probe | Reports `corpus = memory \| wiki \| all`, watcher count, MCP reachability. The SDK probe failure is caught internally so status itself always returns. |
| `wiki_search` | `search_memory` for `corpus=memory`; `query_sdk` running a single SDK script that fans out to `client.watchers.list` + `client.knowledge.read({ semantic_type: 'claim' })` + `client.knowledge.read({ semantic_type: 'synthesis' })` for `corpus=wiki`; merges both for `corpus=all` | Short queries (<3 chars) embed `includeContent=false` so the SDK script skips the knowledge calls. |
| `wiki_get` | `query_sdk` running `client.watchers.get` / `client.knowledge.read({ window_id })` / `client.knowledge.read({ content_ids })` / `client.knowledge.read({ query })` | Lookup parser accepts `event:123`, `watcher:7`, `window:9`, `reports/watchers/4`, or a free-text query. |
| `wiki_apply` | `save_memory` (MCP) for `create_synthesis`; `run_sdk` running `client.watchers.submitFeedback` for `update_metadata` with `watcher_id`/`window_id`/`corrections`; `save_memory` claim fallback otherwise | Corrections must contain `field_path`; empty or malformed arrays throw before MCP is called. |
| `wiki_lint` | In-plugin session ring buffer (cap 32) | Warns when `wiki_apply` was called with no evidence, when `status=active` confidence is below `0.5`, and when a wiki/memory search returned zero results. |
| `memory_search`, `memory_get` | `search_memory` (MCP); `query_sdk` running `client.knowledge.read` | OpenClaw-named aliases. `memory_search` does not route corpus — use `wiki_search` for that. |

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
