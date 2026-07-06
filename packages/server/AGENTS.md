# Server package agent rules

Read root `AGENTS.md` first. This package owns the gateway, auth, connections, feeds, orchestration, connector operations, guardrails, Slackbot MCP integration, and embedded runtime.

## Boundaries and vocabulary
- Connections are rows, not processes. Agents bind to connections/channels; replicas hydrate connection instances on demand from DB rows and must not assume boot warm-start.
- Connectors collect external data into feeds/events; chat platforms deliver conversations/messages. Do not blur connector sync with chat transport.
- Behaviors are the UI umbrella: Listen, Watch, Schedule. A watcher owns windows; a window's living state is a canvas (`semantic_type='canvas_state'`). Artifacts are stored files, not watcher state.
- Platform isolation: InteractionService events carry `platform`; each renderer filters on its own platform and never another's.

## Connections, feeds, and routing
- Chat platforms live under `src/gateway/connections/` and use Chat SDK adapters. Configure connections via `/agents` UI or CRUD API; do not add per-platform env vars or bespoke SDK transports.
- Webhooks are the default transport. Telegram alone supports `auto|webhook|polling`; reject polling in cloud mode.
- `feeds` is the unified list. `kind='collected'` feeds are scheduled connector pulls into `events`; `kind='streaming'` feeds are chat channels backed by `channel_messages`, not scheduled syncs; `virtual` feeds are projections/metadata and must not be queued as real sync work.
- Runtime connection ids may be slugs/managed ids (for example `slackinst-…`), not numeric `connections.id`. Resolve through connection stores; do not cast runtime ids to bigint.
- Bound chat channels should materialize an idempotent streaming feed so the UI has one feed model, not a separate channel island.

## Auth, providers, and secrets
- Product auth uses better-auth/session/PAT flows in `src/auth`; model/provider auth and user auth profiles live under `src/gateway/auth`.
- Provider catalog/settings are org/user scoped. Do not hardcode provider credentials, base URLs, or model lists; resolve through the provider catalog/settings stores.
- Workers never see real credentials. The gateway secret/MCP proxies swap placeholders or inject OAuth/API credentials at egress.
- MCP servers come from per-agent settings or `SKILL.md`; workers discover tools at startup and call them through the gateway proxy.
- Device-pinned connectors are special: resolved connection credentials may be delivered only to the authorized device worker that owns that run.

## Multi-replica correctness
- Production can run N>1 replicas behind ClientIP affinity. Before claiming a feature works, ask: “does this hold with 3 replicas?”
- Per-pod state (`SseManager`, event backlog, in-process worker map, deploy-lock cache) is pod-local. Cross-replica delivery must use Postgres (`thread_response` queue or equivalent).
- API/SSE terminal rows and interaction cards are owner-routed; non-owners requeue until the owning pod claims. Headless rows with no SSE client may be delivered by first claim.
- Streaming deltas/status are best-effort across pods today. Do not build correctness on cross-pod in-memory delivery.
- Exclusive transports such as Telegram polling run on exactly one replica via `connection_claims`; webhook transports must run on any replica.

## Connector operations and repair
- Built-in connector definitions/catalog install in server; connector implementation details belong in `packages/connectors/AGENTS.md`.
- Connector health/repair scans `connections` + `feeds`; chat connections are not collector connections and should not trip zero-feed collector health rules.
- Repair agents may use manage/query tools, but fixes must stay org-scoped and data-driven.

## Guardrails, network, and runtime
- Guardrails live under `packages/core/src/guardrails/`; server built-ins/aggregation live under gateway guardrail code. Guardrail infra errors fail open; each trip writes a `guardrail-trip` event.
- Worker egress goes through `HTTP_PROXY=http://localhost:8118` plus `WORKER_ALLOWED_DOMAINS`/`WORKER_DISALLOWED_DOMAINS`; Linux prod also denies direct network except loopback.
- Workers are subprocesses under `./workspaces/{agentId}/` with `WORKSPACE_DIR`; Linux wraps them in `systemd-run --user --scope` for limits.

## Local dev and validation
- Prereqs: Bun, supported Node per package engines, and Postgres+pgvector via `DATABASE_URL`. `./scripts/setup-dev.sh` provisions local Postgres where needed.
- `make dev` uses shared brew Postgres with one DB per branch. `LOBU_EMBEDDED=1 make dev` / `make dev-embedded` uses embedded per-worktree Postgres.
- Parallel worktrees use `.env.local` for non-default `PORT`/`WORKER_PROXY_PORT`; do not `git switch` while a dev server runs.
- Relevant validation: `make build-packages`, `bun run typecheck`, server tests as needed, and `make review` unless explicitly waived.

## Slackbot MCP integration
- Slackbot is an MCP client. A Slack app exposes tools/resources only with `mcp:connect` bot scope plus an `mcp_servers` manifest block; after scope changes, reinstall the app.
- Manifest template: `config/slack-app-manifest.self-install.json`. Manage it with `scripts/slack-manifest.ts` (`print|validate|update`) and Slack config credentials.
- `/mcp` is mounted at app root, not under `/lobu`. Manifest MCP URL is `<origin>/mcp`; webhook/slash/OAuth URLs keep the `/lobu` base. Do not change this to `/lobu/mcp`.
- OAuth/redirect/`WWW-Authenticate` URLs come from `PUBLIC_GATEWAY_URL` cached at boot. For Slack cloud flows this must be a public HTTPS origin; update env and restart when switching origins.
- Local public dev endpoint is Tailscale Funnel to gateway `:8787`; verify `/mcp` returns auth challenge, not 404.
