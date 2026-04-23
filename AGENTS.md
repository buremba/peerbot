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

#### Guardrails
- Primitive lives in `packages/core/src/guardrails/`: `Guardrail<stage>`, `GuardrailRegistry`, `runGuardrails()`. Stages: `input` (user message → worker), `output` (worker text → user), `pre-tool` (tool call authorization).
- Each guardrail's `run(ctx)` returns `{ tripped, reason?, metadata? }`. The runner races all enabled guardrails at a stage; the first trip short-circuits (later results are discarded) and a thrown guardrail is logged and treated as a pass.
- Enable per-agent in `lobu.toml`: `[agents.<id>] guardrails = ["secret-scan", "prompt-injection"]`. Names must match a guardrail registered in the gateway's `GuardrailRegistry` at startup.
- Built-in: `createNoopGuardrail(stage, name?)` for tests and as a template. Real guardrails (prompt-injection classifier, secret/PII scanner) live in downstream packages that call `registry.register(...)` during gateway boot.

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

## Scope discipline and branch hygiene

When the user pivots mid-session, the default failure mode is piling unrelated work onto one branch and producing a tangled PR. Prevent that:

- **One branch = one concern.** Never mix unrelated features on a single branch.
- **When the user asks for something tangential to the current branch**, stop and say out loud: *"that's a separate concern — I'll finish/push the current work and start a fresh branch."* Then:
  1. Commit and push what you have.
  2. Open the PR for the current branch (or leave it draft if not ready).
  3. `git switch main && git pull && git switch -c feat/<new-thing>` before touching any new code.
- **When the new ask genuinely builds on unmerged code**, stack it: `git switch -c feat/b feat/a` off the existing feature branch and open PR #2 targeting `feat/a` (not `main`). Rebase PR #2 onto `main` once PR #1 merges.
- **Never `git stash`.** Stashes are invisible, easy to lose, and collide across agents. If you need to pivot without finishing, commit WIP to the current branch (`git add -A && git commit -m "wip"`) and squash later. WIP commits are visible, pushable, recoverable.
- **Per-agent isolation:** when launching a parallel Claude Code session, use `claude --worktree <name>` so each agent gets its own checkout + branch. No shared working dir = no cross-agent collisions.
- **If a branch has already gotten mixed**, recover with `git rebase -i` + `git reset HEAD~N` and re-commit in clean groups before opening PRs.

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
