# Tool-surface eval — glm-4.7

Empirical comparison of two ways to expose Lobu's MCP tools to an agent model,
run against the **real glm-4.7 model via the z-ai provider**:

- **Arm A — discrete MCP** (`mcpExposure: "tools"`, the default cloud surface):
  all ~23 Lobu MCP tools are first-class function-call tools.
- **Arm B — just-bash / MCP-as-CLI** (`mcpExposure: "cli"`, the embedded
  deployment surface): one `bash` tool, and the MCP tools are reachable as
  `lobu <tool> <<<'{json}'`, discoverable via `lobu --help` and
  `lobu <tool> --schema`.

The toggle that selects between them in production is the worker's
`mcpExposure` (set per-agent via `toolsConfig.mcpExposure` or the
`LOBU_MCP_EXPOSURE=cli` env var) — see
`packages/agent-worker/src/openclaw/worker.ts`.

## What is real vs. reconstructed

- **Model:** real glm-4.7 over z-ai (`Z_AI_API_KEY`), model object built exactly
  as the worker's `model-resolver.ts` does (openai-completions, base URL
  `https://api.z.ai/api/coding/paas/v4`, `compat.supportsStore=false`).
- **Tools:** the REAL Lobu MCP handlers (`manage_entity`, `save_memory`,
  `search_memory`, `query_sql`, `manage_watchers`, …) against a real Postgres
  (the server package's test fixtures + migrations on `lobu_test`).
- **Arm A surface:** the real discrete tool list from
  `getAllTools()` (names/descriptions/JSON schemas).
- **Arm B surface:** the real `buildMcpCliCommands` + the worker's real
  `createOpenClawTools` bash + just-bash interpreter. The only swap is the
  gateway HTTP `callTool` → an out-of-process dispatcher (see below).

## The one deliberate divergence (and why)

just-bash hardens `Error.stackTraceLimit` to non-writable for the duration of a
custom-command execution. postgres.js stamps a cached Error on every query
(`Error.stackTraceLimit = 4`), so running the DB handlers **in-process inside a
just-bash command** throws "Attempted to assign to readonly property".

Production never hits this: the MCP-CLI handler calls the gateway over HTTP and
the DB work runs in the **gateway process**. We reproduce that exact boundary —
`dispatcher-server.ts` is a separate Bun process owning the Postgres connection
and the real handlers; Arm B's `callTool` reaches it via `fetch`, just like
`callMcpTool` reaches the gateway. So Arm B's model-facing surface (heredoc
parsing, quoting, `lobu <tool>` dispatch, JSON-on-stdin) is the worker's, and the
DB work runs across a real process boundary as in prod.

## Run it

```bash
DATABASE_URL=postgresql://localhost:5432/lobu_test \
Z_AI_API_KEY=<your z-ai key> \
bun run.ts --trials 3 --arms A,B
# optional: --tasks create-lead,advance-stage
```

Requirements: a reachable Postgres with the `vector` + `pg_trgm` extensions
(the runner runs migrations on the `*test*` database). Bun. A z-ai API key.

## Tasks

Six CRM-ops tasks drawn from the `crm-ops` skill (lead/pilot funnel). Each has a
deterministic seed (identical per arm) and a programmatic success check against
DB/entity/event state — not just the model's reply. Read tasks additionally
score the final reply text. See `tasks.ts`.

## Files

- `scenario.ts` — DB setup, CRM type seeding, the tool dispatcher (real handlers).
- `arms.ts` — builds the Arm A and Arm B glm-4.7 sessions.
- `dispatcher-server.ts` — out-of-process tool backend for Arm B.
- `tasks.ts` — the 6 tasks + seeds + state/reply checks.
- `run.ts` — the runner; collects metrics, prints the comparison tables.
