## Project Structure & Module Organization

### Package Architecture
- **`packages/core`**: Shared code between gateway and worker (interfaces, utils, types). Any code reused by both must live here.
- **`packages/gateway`**: Platform-agnostic gateway. Platform connections managed via Chat SDK adapters in `src/connections/`. Orchestration under `src/orchestration/`.
- **`packages/worker`**: Agent execution via OpenClaw runtime in `src/openclaw/`. Worker talks only to gateway and agent. No platform knowledge.

### Module Boundaries
- Gateway: Connections → `src/connections/`, orchestration → `src/orchestration/`, Slack OAuth routes → `src/routes/public/slack.ts`
- Worker: Platform-agnostic, agent logic isolated to `src/openclaw/`
- Core: Shared interfaces, utils, types for gateway+worker
- **Platform isolation**: InteractionService events (e.g. `link-button:created`) carry an explicit `platform` field. Each platform renderer MUST filter on its own platform identity (`platform === "telegram"`, `platform === "slack"`). Never reference another platform's identifier.

### Repository Layout
- Monorepo managed by Bun workspaces under `packages/*`.
- Top-level: `Makefile`, `scripts/`, `charts/lobu` (Helm), `config/`, `docker/`, `docs/` (RELEASING, SECURITY), `.env*`.
- TypeScript sources in `packages/*/src`, tests in `packages/*/src/__tests__`.
- Always prefer `bun` over `npm`.
- When fixing unused-parameter errors, delete the parameter rather than prefixing with `_`.

### Submodules
`packages/owletto-web` is a submodule of `lobu-ai/owletto-web`. Every change there ships as **two PRs**: (1) land the submodule PR; (2) open a parent PR that bumps the pointer. Never push a parent commit that references an unmerged submodule SHA — production resolves SHAs from the parent and will break. After the submodule PR merges: `git -C packages/owletto-web pull --ff-only origin main`, stage the submodule in the parent, open the bump PR.

### Architecture

#### Platform
All chat platforms (Telegram, Slack, Discord, WhatsApp, Teams) run through Chat SDK adapters in `packages/gateway/src/connections/`. Connections are created via the `/agents` admin UI or the connections CRUD API — no per-platform env vars. Each connection has a typed config schema (bot token for Telegram, signing secret + bot token for Slack, etc.). Gateway also exposes a public endpoint that triggers an agent run. Settings-page provider order is drag-sortable, with per-provider model selection inline.

#### Orchestration
- Deployment modes: Kubernetes (production), Docker Compose (development).
- Workers are sandboxed and **never see real credentials**. The gateway proxy resolves provider credentials from the agentId in the URL path (`/api/proxy/{slug}/a/{agentId}/...`); workers get opaque placeholders in env.

#### MCP
- Bundled LLM providers come from `config/providers.json`; MCP servers come from per-agent settings or local `SKILL.md` files.
- Workers discover MCP tools at startup and register them as first-class agent tools (direct function calls, not curl instructions).
- Workers call MCP tools via the gateway proxy using their JWT.
- Built-in MCPs: `AskUser` (request user input), `UploadFile` (share files with user).
- **Integration auth lives in Owletto** — OAuth, token refresh, and API proxying for third-party services (GitHub, Google, etc.) are handled by Owletto MCP servers. Workers never see OAuth tokens.

#### Network
- Workers run on the internal-only `lobu-internal` network; the gateway sits on both `lobu-public` and `lobu-internal` and is the single egress.
- Gateway runs a Node HTTP proxy on :8118; workers get `HTTP_PROXY=http://gateway:8118` for all outbound (curl/wget/npm/git).
- Access is controlled by `WORKER_ALLOWED_DOMAINS`:
  - Empty/unset → no internet (default).
  - `"github.com"` → allowlist only.
  - `"*"` → allow all (not for production).
  - `"*"` + `WORKER_DISALLOWED_DOMAINS="malicious.com,spam.org"` → blocklist mode.
- Domain format: exact (`api.example.com`) or wildcard (`.example.com`).
- Docker's `internal: true` enforces isolation at the infra layer; the proxy adds selective egress on top.
- `WORKER_ENV_*` gateway vars are forwarded to workers with the prefix stripped (`WORKER_ENV_FOO=bar` → `FOO=bar`). Use only for worker runtime env, not the default Owletto memory plugin config.

## TypeScript Build System

TypeScript packages must be compiled from `src/` → `dist/`. If you modify any package source code, run `make build-packages`. `make dev` (docker compose watch) automatically builds and syncs changes.

## Versioning and releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please): land conventional commits on `main`, merge the generated release PR, and CI publishes to npm (OIDC) and builds Docker images. See [`docs/RELEASING.md`](docs/RELEASING.md) for the full flow, recovery playbook, and local-publish fallback.

Rules for agents:
- Inter-package deps MUST be `"@lobu/<name>": "workspace:*"` — never a hardcoded version. `scripts/publish-packages.mjs` rewrites them at publish time.
- Don't hand-edit `packages/*/package.json` versions and don't push `chore(release)` commits directly; release-please owns those.
- Source of truth for the current version: `.release-please-manifest.json` plus the `v<version>` tags.

## Agent Rules
- Do only what's asked — nothing more, nothing less.
- Don't create `*.md` files unless explicitly asked. Add memory to `CLAUDE.md` as a single sentence.
- Delete any ephemeral files you create.
- Ignore `/dist/` — compiled artifacts, not source.
- After editing `packages/worker/*`, run `make clean-workers` so new workers pick up the change.
- When the user pastes a Slack link (`slack.com/archives/…?thread_ts=`), call `./scripts/slack-thread-viewer.js "<link>"` first.
- In planning mode, when unsure, ask: `codex exec "QUESTION" --config model_reasoning_effort="high"`.

## Development

Prerequisites: Bun, Docker Desktop.

```bash
./scripts/setup-dev.sh   # first-time setup
make dev                  # docker compose watch (auto-syncs source)
make clean-workers        # after worker/* changes
make deploy               # Kubernetes (production)
docker compose -f docker/docker-compose.yml logs -f gateway
```

### Validation after code changes

Run the validation that matches what you touched:

| Change | Command |
| --- | --- |
| `packages/landing/*` | `cd packages/landing && bun run build` |
| `packages/{core,gateway,worker,cli}/*` | `make build-packages` |
| Broad TS check | `bun run typecheck` |

For MCP work, verify tool calls against the gateway proxy or Owletto directly (e.g. via `bun -e`) before exercising the full agent loop.

If the change affects bot behavior, run the test bot:

```bash
./scripts/test-bot.sh "@me test prompt"              # single
./scripts/test-bot.sh "@me first" "follow up"        # multi-turn
# Telegram: TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot ./scripts/test-bot.sh "…"
```

If replies look stale, clear Redis chat history:

```bash
docker compose -f docker/docker-compose.yml exec redis redis-cli KEYS 'chat:history:*'
docker compose -f docker/docker-compose.yml exec redis redis-cli DEL 'chat:history:<key>'
```

For prompt / behavior changes, run evals (definitions in `<example>/agents/<name>/evals/*.yaml`):

```bash
lobu eval                    # all evals for default agent
lobu eval ping               # single eval
lobu eval -m claude/sonnet   # with model override
lobu eval --list
```

Local dev Telegram bot: `@clawdotfreebot`. Production: `@lobuaibot`.

## Environment & Runtime

`.env` is the single source of truth for secrets. Gateway reads it on startup; restart with `make dev` after changes. In Kubernetes, a checksum annotation triggers pod restart when secrets change via `helm upgrade`.

Workers get persistent storage for session continuity across scale-to-zero:

- **K8s**: each worker deployment has its own PVC mounted at `/workspace` (1 thread = 1 PVC). Sessions live in `/workspace/` (`HOME=/workspace`). PVCs are deleted when the deployment is cleaned up after thread inactivity; on scale-up, existing sessions auto-resume.
- **Docker**: equivalent host mount at `./workspaces/{threadId}/`.

### Integration authentication

OAuth for third-party APIs (GitHub, Google, Linear, etc.) is handled by **Owletto**, not the gateway. Workers hit those APIs through Owletto MCP tools and never see tokens directly.

Skills that need network declare `networkConfig.allowedDomains`; skills that need system tools declare `nixPackages`. Both are merged into the agent's allowlist / Nix env when the skill is enabled, with no per-skill approval prompt — review skills before installing. Destructive MCP tool calls still require in-thread approval unless pre-approved in `[agents.<id>.tools]` in `lobu.toml`.
