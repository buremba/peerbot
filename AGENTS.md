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
- Monorepo managed by Bun workspaces: `packages/gateway`, `packages/worker`, `packages/core`.
- Top-level: `Makefile`, `scripts/` (CLI/setup), `charts/lobu` (Helm), `config/` (biome, knip, etc.), `docker/` (Dockerfiles, compose), `docs/` (CONTRIBUTING, SECURITY), `.env*`.
- TypeScript sources under `packages/*/src`. Tests in `packages/*/src/__tests__` and `packages/core/tests`.
- **ALWAYS prefer `bun` commands over `npm`**
- When fixing unused parameter errors, remove the parameter entirely if possible rather than prefixing with underscore
- Worker prompt delivery: prompts are passed to the agent runtime directly (no named pipes used)

### Submodules
- `packages/owletto-web` is a git submodule pointing at `lobu-ai/owletto-web`. ANY code change inside it must ship as TWO PRs in this order: (1) submodule PR in `lobu-ai/owletto-web`, merge it; (2) parent PR in `lobu-ai/lobu` that bumps the submodule pointer. Never push parent commits that reference an unmerged submodule SHA — the production build resolves submodule SHAs from the parent and the deploy will break.
- After the submodule PR merges, run `git -C packages/owletto-web pull --ff-only origin main`, stage `packages/owletto-web` in the parent, and open the parent bump PR.

### Architecture

#### Platform
All messaging platforms (Telegram, Slack, Discord, WhatsApp, Teams) are managed via Chat SDK adapters in `packages/gateway/src/connections/`. Connections are created via the admin page UI (`/agents`) or the connections CRUD API — no platform-specific env vars required. Each connection has a typed config schema (e.g. bot token for Telegram, signing secret + bot token for Slack). There is also a public endpoint in gateway to trigger running the agent.
Settings page provider order is drag-sortable via handle, with per-provider model selection inline in each provider row.

#### Orchestration
- **Deployment modes**: Kubernetes (production), Docker (development)
- All workers are sandboxed with your settings.
- **Workers must NEVER see real credentials.** Provider credentials are resolved by the gateway proxy using agentId from the URL path (`/api/proxy/{slug}/a/{agentId}/...`). Workers only receive opaque placeholders in env vars.

#### MCP
- Bundled LLM providers are registered via `config/providers.json`; MCP servers come from per-agent settings or local SKILL.md files.
- Workers discover MCP tools at startup and register them as first-class agent tools (direct function calls, not curl instructions).
- Workers call MCP tools through the gateway proxy using their JWT token.
- Built-in MCPs available to workers: AskUser (request user input), UploadFile (share files with user).
- **Integration auth is handled by Owletto** — OAuth credentials, token refresh, and API proxying for third-party services (GitHub, Google, etc.) are managed by Owletto MCP servers. Workers call integration APIs through Owletto MCP tools; they never see OAuth tokens directly.

#### Network

- Workers run on isolated internal network (`lobu-internal`) with no direct internet access. Gateway sits on both `lobu-public` and `lobu-internal` networks, acting as single egress point.
- **Proxy filtering**: Gateway runs custom Node.js HTTP proxy on port 8118. Workers configured with `HTTP_PROXY=http://gateway:8118` for all outbound requests (curl/wget/npm/git).
- **Network access control** (via `WORKER_ALLOWED_DOMAINS` environment variable):
  - **Complete isolation** (default): Leave empty or unset → workers have NO internet access
  - **Allowlist mode**: `WORKER_ALLOWED_DOMAINS="github.com"` → deny by default, allow only these domains
  - **Unrestricted access**: `WORKER_ALLOWED_DOMAINS="*"` → allow all domains (not recommended for production)
  - **Blocklist mode**: `WORKER_ALLOWED_DOMAINS="*"` + `WORKER_DISALLOWED_DOMAINS="malicious.com,spam.org"` → allow all except blocked
- **Domain format**: Exact domain (`api.example.com`) or wildcard (`.example.com` matches `*.example.com`)
- **Enforcement**: Docker's `internal: true` network flag prevents routing to external networks at infrastructure layer. Even if worker code is compromised, no network route exists. HTTP proxy provides selective access to approved domains only.
- **Worker env passthrough**: Gateway env vars prefixed with `WORKER_ENV_` are forwarded to workers with the prefix stripped. Example: `WORKER_ENV_FOO=bar` → worker sees `FOO=bar`. Use this only for worker-specific runtime env, not for the default Owletto memory plugin config.

## TypeScript Build System

TypeScript packages must be compiled from `src/` → `dist/`. If you modify any package source code, run `make build-packages`. `make dev` (docker compose watch) automatically builds and syncs changes.

## Versioning and releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please). You never bump versions by hand — just land feature work on `main` via PRs with conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`, etc.) and release-please opens a release PR. Merging the release PR triggers the automated publish to npm via OIDC trusted publishing and dispatches the Docker image build. See [`docs/RELEASING.md`](docs/RELEASING.md) for the full flow, commit conventions, recovery playbook, and local-publish fallback.

Implementation details for when you need to change the release system itself:

- **Inter-package deps MUST use `"@lobu/<name>": "workspace:*"`**, never a hardcoded version string. `scripts/publish-packages.mjs` rewrites `workspace:*` to the current root version right before `npm publish` and restores the file afterwards.
- Don't hand-edit versions in individual `packages/*/package.json` files and don't push `chore(release)` bumps directly. release-please writes those commits via its release PR.
- `scripts/bump-version.mjs` still exists for manual fallback, but the normal path is release-please. If you have to run it, land the version bump via a PR, not a direct push.
- The single source of truth for the "current version" is `.release-please-manifest.json` plus the `v<version>` git tags. Keep them in sync if you ever edit either.
- Adding a new published workspace means updating two files: `release-please-config.json` (to add `extra-files` for the new `package.json`) and `scripts/publish-packages.mjs` (`PACKAGES` array).

## Instructions
- You MUST only do what has been asked; nothing more, nothing less.
- When the user types a Slack message link (slack.com/archives/x/x/?thread_ts=) you MUST call ./scripts/slack-thread-viewer.js "link" to gather context
- When you are in planning mode and you're not fully sure, you need to ask 'codex exec "YOUR_QUESTION" --config model_reasoning_effort="high"'
- When you make changes to worker code (`packages/worker/*`), run `make clean-workers` to ensure new workers use the updated code.
- The "is running" thread status indicator (with rotating messages) provides user feedback during processing; visible "Still processing" heartbeat messages are not sent to avoid clutter.
- Anytime you make changes in the code, you MUST:

1. Have the stack running (`make dev`).
2. Run validations that match the surface you changed — do not skip the relevant app:
   - `packages/landing/*`: run `cd packages/landing && bun run build`
   - `packages/core/*`, `packages/gateway/*`, `packages/worker/*`, `packages/cli/*`: run `make build-packages`
   - For broad TS safety across the repo, prefer `bun run typecheck` when practical
3. When possible, first verify MCP tool calls work by calling the gateway proxy or Owletto directly (e.g., via a temporary script or `bun -e`). This catches issues before involving the full agent loop.
4. If your change affects bot behavior, worker execution, gateway orchestration, platform integrations, MCP tools, or agent responses, test the bot using the test script:
```bash
./scripts/test-bot.sh "@me test prompt"
```
The script automatically handles sending the message, waiting for response, and checking logs. You can send multiple messages in sequence:
```bash
./scripts/test-bot.sh "@me first message" "follow up question" "another question"
```
5. If the bot gives stale/wrong responses, clear Redis chat history for the test user before retesting:
```bash
docker compose -f docker/docker-compose.yml exec redis redis-cli KEYS 'chat:history:*' # find the key
docker compose -f docker/docker-compose.yml exec redis redis-cli DEL 'chat:history:<key>'
```

6. For automated quality checks, use the eval system when the change affects agent behavior or prompt quality:
```bash
lobu eval                    # run all evals for default agent
lobu eval ping               # run a specific eval
lobu eval -m claude/sonnet   # eval with a specific model
lobu eval --list             # list available evals
```
Eval definitions live in `agents/{name}/evals/*.yaml`. See [lobu.ai/guides/evals](https://lobu.ai/guides/evals/) for format details.

- If you create ephemeral files, you MUST delete them when you're done with them.
- Use Docker to build and run the bot in development mode, K8S for production.
- NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User. If you need to remember something, add it to CLAUDE.md as a single sentence.
- ALWAYS ignore `/dist/` directories when analyzing code - these contain compiled artifacts, not source

## Development Mode

### Prerequisites
- Bun: installed
- Docker Desktop: running

### First-time Setup
```bash
./scripts/setup-dev.sh
```

### Starting Development
```bash
make dev
```

This runs `docker compose watch` which starts the full stack (gateway, Redis, etc.) and auto-syncs source changes into containers. No manual rebuilds needed.

### Hot Reload
- **Gateway + Packages**: `docker compose watch` (`make dev`) auto-syncs source changes
- **Worker**: Run `make clean-workers` after worker code changes

### Check Logs
```bash
docker compose -f docker/docker-compose.yml logs -f gateway
```

### Deployment
1. **Development**: `make dev` (docker compose watch)
2. **Kubernetes deployment**: Use `make deploy` for production deployment

## Environment Configuration

The `.env` file is the single source of truth for all secrets and configuration.

### Local Development
- Gateway reads `.env` on startup via Docker Compose
- Restart after `.env` changes: `make dev` (or `docker compose -f docker/docker-compose.yml up`)

The gateway deployment has a checksum annotation that triggers automatic pod restart when secrets change via `helm upgrade`.

Worker deployments use persistent volumes for session continuity across scale-to-zero:

1. **Per-Deployment PVC**: Each worker deployment gets its own PersistentVolumeClaim (1 thread = 1 PVC) mounted at `/workspace`
2. **Session Storage**: Agent sessions are stored in `/workspace/` (via `HOME=/workspace` environment variable)
3. **Auto-Resume**: When a worker scales back up, it automatically detects existing sessions and resumes
4. **Cleanup**: PVCs are automatically deleted when deployments are cleaned up after thread inactivity
5. **Docker Mode**: Uses host directory mounts at `./workspaces/{threadId}/` for equivalent persistence

### Integration Authentication

OAuth authentication for third-party APIs (GitHub, Google, Linear, etc.) is handled by **Owletto**, not by the Lobu gateway. Workers access these APIs through Owletto MCP tools, which handle credential management, token refresh, and API proxying. Workers never see OAuth tokens directly.

Skills that need direct network access (e.g., `git clone`) declare `networkConfig.allowedDomains`, which is merged into the agent's network allowlist when the skill is enabled. Skills that need system tools declare `nixPackages` which are merged into the worker's Nix environment. Review skills before installing — declared domains and packages are applied without a separate per-skill approval step. Destructive MCP tool calls still require in-thread approval unless the operator pre-approves them in `[agents.<id>.tools]` in `lobu.toml`.

Local dev Telegram bot is `@clawdotfreebot`, production is `@lobuaibot`.
To test Telegram bot, use `TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot ./scripts/test-bot.sh "message"` (or set `TELEGRAM_TEST_CHAT_ID`); this path uses `tguser` and sends as your real user account.
When testing locally, always start the stack with `make dev` (docker compose watch) so changes auto-sync.
