<!-- Project rules for agents working in this repo. CLAUDE.md inlines this file at the top of every session, then appends repo-local notes. -->

## Project Structure & Module Organization

### Package Architecture
- **`packages/core`**: Shared interfaces, utils, and types reused by gateway and worker.
- **`packages/server`**: Embedded server + platform-agnostic gateway. Connections → `src/gateway/connections/`, orchestration → `src/gateway/orchestration/`, Slack OAuth routes → `src/gateway/routes/public/slack.ts`.
- **`packages/agent-worker`**: Agent execution via OpenClaw runtime in `src/openclaw/`. Talks only to gateway and agent; no platform knowledge.
- **Platform isolation**: InteractionService events carry an explicit `platform` field. Each platform renderer MUST filter on its own identity (`platform === "telegram"`, etc.); never reference another platform's identifier.

### Repository Layout
- Monorepo managed by Bun workspaces under `packages/*`.
- Top-level: `Makefile`, `scripts/`, `config/`, `docs/` (RELEASING, SECURITY), `.env*`.
- TypeScript sources in `packages/*/src`, tests in `packages/*/src/__tests__`.
- Always prefer `bun` over `npm`.
- When fixing unused-parameter errors, delete the parameter rather than prefixing with `_`.
- Landing page copy (`packages/landing`): never use em dashes (`—`) in user-facing text. Rephrase with commas, periods, or restructure the sentence.

### Submodules
`packages/owletto` is a submodule of `lobu-ai/owletto`. Push the submodule change to a reachable branch first, then bump the pointer in the parent — an unreachable SHA breaks production cloning.

Before pushing any `bun.lock` or `package.json` change, initialise the submodule and re-lock — an uninitialised submodule prunes the owletto half of the graph and Bun rewrites the lockfile, failing CI's frozen-check on the next push:

```bash
git submodule update --init packages/owletto
bun install --frozen-lockfile
```

If that rewrites `bun.lock`, commit the regenerated lockfile in the same change.

### Frontend (owletto)
When editing UI under `packages/owletto`, follow the design rules in @packages/owletto/DESIGN_GUIDELINES.md — confirmations, surfaces, empty states, selection, forms, page copy, radius, Sheet vs Dialog. Match the existing components and exemplar files referenced there; do not introduce new primitives without updating the guideline in the same PR.

### Architecture

#### Platform
All chat platforms (Telegram, Slack, Discord, WhatsApp, Teams) run through Chat SDK adapters in `packages/server/src/gateway/connections/`. Connections are created via the `/agents` admin UI or the connections CRUD API — no per-platform env vars. Each connection has a typed config schema (bot token for Telegram, signing secret + bot token for Slack, etc.). Gateway also exposes a public endpoint that triggers an agent run.

**Webhooks via the Chat SDK adapter are the default transport.** Don't add per-platform alternative transports (Slack Socket Mode, Discord Gateway bridges) or extra runtime SDKs. Telegram is the only exception — its connection config supports `mode: "auto" | "webhook" | "polling"` inside the Chat SDK adapter, still no extra SDK.

`mode: "polling"` is rejected when `LOBU_CLOUD_MODE=1` — a polling worker shares one Telegram edge connection across tenants, so a misbehaving one degrades delivery for everyone. Self-hosters (`LOBU_CLOUD_MODE` unset/0) keep polling for tunnel-less dev.

#### Orchestration
- **Embedded process model.** Within a single app process the gateway, the worker *orchestrator*, embeddings, and the Lobu memory backend run together. Workers spawn from `EmbeddedDeploymentManager` as `child_process.spawn` subprocesses with `cwd = ./workspaces/{agentId}/` and `WORKSPACE_DIR` env (on Linux, wrapped in `systemd-run --user --scope` for MemoryMax/CPUQuota/IPAddressDeny+capability drops). "No Docker/Kubernetes" applies to **worker orchestration only** — workers are child processes, never pods. The app process itself runs as a multi-replica k8s Deployment (see below).
- Postgres (with `pgvector`; optionally `postgis` for geo enrichment) is the only user-provided external. The Node process connects out via `DATABASE_URL`. Runtime state — queues, chat connection rows, grant cache, MCP proxy sessions — lives in dedicated Postgres tables.
- **🚨 Multi-replica k8s is the production reality — every change MUST be correct under N>1 app replicas.** The app ships as a k8s `Deployment` (`charts/lobu`) whose `app.replicaCount` is routinely >1, behind `sessionAffinity: ClientIP` because per-pod state — `SseManager` connections **and** its event backlog (`sse-manager.ts`), the in-process `workers` map, the deployment-creation lock cache — is **in-memory and pod-local with no cross-pod fan-out**. On every task:
  - A client's SSE stream, its `POST /messages`, and its conversation's worker are co-located on one pod **only** because ClientIP affinity pins them. Don't assume two requests for the same conversation hit the same pod for any other reason.
  - Cross-replica delivery rides Postgres: a worker reply reaches the client's SSE pod via the `thread_response` queue (any pod's consumer may claim a row and broadcasts to *its* local `SseManager`). An event broadcast on the wrong pod is silently dropped. Platform responses are owner-routed (`ChatResponseBridge.canHandle` re-queues until the owning pod claims); **API/SSE responses are not** — a known gap.
  - **Never introduce shared state as an in-memory Map/singleton that another replica needs to read or mutate.** Per-pod in-memory state is fine only for data that pod exclusively owns (its own SSE connections, its own spawned workers). Anything observed/coordinated across replicas goes in Postgres.
  - Before claiming a feature works, answer explicitly: *"does this hold with 3 app replicas behind ClientIP affinity?"* If a fix relies on one component (dispatch) seeing another component's event (completion) and they can land on different pods, it is broken in prod — use a Postgres-mediated signal instead.
- Workers are sandboxed and **never see real credentials**. The gateway's `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real keys at egress; workers receive only the placeholders.

#### MCP
- Bundled LLM providers come from `config/providers.json`; MCP servers come from per-agent settings or local `SKILL.md` files.
- Workers discover MCP tools at startup and register them as first-class agent tools (direct function calls, not curl instructions).
- Workers call MCP tools via the gateway proxy using their JWT.
- Built-in MCPs: `AskUser` (request user input), `UploadFile` (share files with user).
- **Integration auth lives in Lobu** — OAuth, token refresh, and API proxying for third-party services (GitHub, Google, etc.) are handled by Lobu MCP servers. Workers never see OAuth tokens.
- **`events` is append-only.** Never `DELETE FROM events`. To hide a row, write a tombstone via `client.knowledge.delete()` or `save_knowledge({ supersedes_event_id, ... })`; the `current_event_records` view masks superseded rows, `include_superseded` recovers history.

#### Connectors
- A connector is a `*.connector.ts` extending `ConnectorRuntime`. **npm deps** go in the project's `package.json` (next to `lobu.toml`) and are **bundled** into the connector by esbuild at compile time. **Native deps** (ffmpeg, imagemagick, …) are declared as nixpkgs refs in `runtime.nix.packages` on the connector `definition`; the runtime provisions them on PATH via `nix-shell` at execution. npm = bundled (compile-time); native = nix (run-time).
- **Compile happens on the CLI**, not the server: `lobu apply` runs `bun install --ignore-scripts` in the project (install scripts off for supply-chain safety — native bits go through `runtime.nix.packages`, not bundled npm), compiles each connector with the project's `node_modules`, and uploads the bundle (`compiled: true`). esbuild resolves a connector's imports relative to the connector file's dir, so the project's deps are used regardless of where the `lobu` binary is installed. `@lobu/connector-sdk` is **externalized** (runtime-provided, à la Lambda's `aws-sdk`) — the bundle stays the connector's own code + deps, not multiple MB of SDK infra.
- `lobu init` scaffolds `package.json` (with `@lobu/connector-sdk` devDependency for editor types) + `tsconfig.json` + `connectors/`.

#### Guardrails
- Primitive lives in `packages/core/src/guardrails/`: `Guardrail<stage>`, `GuardrailRegistry`, `runGuardrails()`. Stages: `input` (user message → worker), `output` (worker text → user), `pre-tool` (tool call authorization).
- Each guardrail's `run(ctx)` returns `{ tripped, reason?, metadata? }`. The runner races all enabled guardrails at a stage; the first trip short-circuits (later results are discarded) and a thrown guardrail is logged and treated as a pass.
- Built-ins ship from `packages/server/src/gateway/guardrails/builtins.ts` and are wired during `CoreServices.initialize`:
  - `secret-scan` (output) — regex scan for OpenAI keys (`sk-…`), GitHub PATs (`ghp_…`), AWS access keys (`AKIA…`), JWT-shaped tokens. Cheap enough to run per streaming delta.
  - `pii-scan` (input / output / pre-tool) — regex sweep for emails, US-shaped phones, and Luhn-valid 13–19 digit card-shaped runs across the user message, worker output, or serialized pre-tool args.
  - `forbidden-tools` (pre-tool) — hardcoded deny-list (`delete_repo`, `delete_branch`, `drop_table`).
- `createNoopGuardrail(stage, name?)` remains a template for downstream packages (prompt-injection classifier, custom PII scrubbers, etc.) that call `registry.register(...)` after `getCoreServices().getGuardrailRegistry()`.

**Configuration:** built-ins listed in `[agents.<id>].guardrails`; ad-hoc LLM judges in `[[agents.<id>.guardrails_inline]]` (per-stage, `tools` narrows pre-tool); skills add `pre-tool` only via their YAML. Operator overrides via `guardrails_disabled` (names match resolved `Guardrail.name`, including synthesized `inline:<stage>:<hash8>` and `skill:<name>:inline:pre-tool:<hash8>`). All merged by `resolveAgentGuardrails()` in `packages/server/src/gateway/guardrails/aggregator.ts` — see that file + `judge-factory.ts` for schema, judge cache, and circuit breaker.

**Trip behavior:** input → dispatch skipped, `Message rejected: <reason>` pushed to user. Output → stream disposed, `Message blocked by guardrail: <reason>` posted, partial buffer dropped. Pre-tool → worker gets `isError: true` with `Tool call blocked by policy.` (reason intentionally hidden — leaking it is an evasion surface). Every trip writes a `semantic_type='guardrail-trip'` event. All three fail open on infrastructure errors.

#### Network
- Gateway runs a Node HTTP proxy on `127.0.0.1:8118`; worker subprocesses get `HTTP_PROXY=http://localhost:8118` for all outbound (curl/wget/npm/git). The proxy enforces domain allowlist/blocklist + LLM egress judge.
- Access is controlled by `WORKER_ALLOWED_DOMAINS`:
  - Empty/unset → no internet (default).
  - `"github.com"` → allowlist only.
  - `"*"` → allow all (not for production).
  - `"*"` + `WORKER_DISALLOWED_DOMAINS="malicious.com,spam.org"` → blocklist mode.
- Domain format: exact (`api.example.com`) or wildcard (`.example.com`).
- In embedded mode `HTTP_PROXY` is advisory at the language layer — a worker can `connect()` directly bypassing it. On Linux production hosts, the systemd-run worker spawn adds `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1` so kernel-level routing forces traffic through the proxy.
- `WORKER_ENV_*` gateway vars are forwarded to workers with the prefix stripped (`WORKER_ENV_FOO=bar` → `FOO=bar`). Use only for worker runtime env, not the default Lobu memory plugin config.

#### Egress judge
Risky domains can route through an LLM judge instead of a flat allow/deny. Skills declare `judge:` domains + named policies in their YAML; operators append `[agents.<id>.egress] extra_policy` in `lobu.toml`. Defaults: Haiku, 5-min verdict cache, circuit breaker fail-closed after 5 failures. Hooks in `packages/server/src/gateway/proxy/http-proxy.ts`. Requires `ANTHROPIC_API_KEY`; every decision logs an `egress-decision` record (no bodies/headers).

## Versioning and releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please): land conventional commits on `main`, merge the generated release PR, and CI publishes to npm (OIDC). See [`docs/RELEASING.md`](docs/RELEASING.md) for the full flow, recovery playbook, and local-publish fallback.

Rules for agents:
- Inter-package deps MUST be `"@lobu/<name>": "workspace:*"` — never a hardcoded version. `scripts/publish-packages.mjs` rewrites them at publish time.
- Don't hand-edit `packages/*/package.json` versions and don't push `chore(release)` commits directly; release-please owns those.
- Source of truth for the current version: `.release-please-manifest.json` plus the `v<version>` tags.

## Agent Rules
- **Never write to `~/Code/lobu` directly — always work in a worktree.** Run `make task-setup NAME=<slug>` first; every commit, branch, submodule bump, and one-line fix goes through `.claude/worktrees/<slug>/`. The main checkout must stay on `main` so other agents can `git worktree add` cleanly. For just advancing a submodule pointer, `make bump SUBMODULE=<path> [TARGET=<ref>]` is the shortcut (skips install/env/ports).
- Do only what's asked — nothing more, nothing less.
- Don't create `*.md` files unless explicitly asked — review noise, and docs drift if no one owns them. Add memory to `CLAUDE.md` as a single sentence — keeps context lean for parallel agents.
- Delete any ephemeral files you create.
- After editing `packages/agent-worker/*`, run `make clean-workers` so new workers pick up the change.
- When the user pastes a Slack link (`slack.com/archives/…?thread_ts=`), run the repo's `scripts/slack-thread-viewer.js "<link>"` first (path is relative to repo root).
- In planning mode, when unsure, ask: `codex exec "QUESTION" --config model_reasoning_effort="high"`.
- **No new dynamic imports outside the allow-list below.** Use static `import` by default; new `await import(...)` sites need a measured cost justification (boot time, install footprint, Keychain prompt) added to this list in the same PR. Rationale for each entry lives as a code comment at the call site:
  - `packages/cli/src/index.ts` — lazy subcommand handlers (keeps `lobu --help` ~60ms).
  - `packages/cli/src/commands/_lib/connector-run-cmd.ts` — `browser-mirror`, `devtools-active-port`, `executeCompiledConnector`.
  - `packages/cli/src/commands/_lib/apply/apply-cmd.ts` — `connector-loader` + `ensure-deps-installed` (the connector-compile graph: esbuild + connector-worker + SDK). Loaded only when an apply has local `*.connector.ts` to compile; keeps that graph out of apply-cmd's module-load path (and out of every CLI test that imports it).
  - `packages/cli/src/commands/_lib/apply/desired-state.ts` — `yaml` (loaded only on YAML inputs).
  - `packages/cli/src/commands/memory/_lib/browser-auth-cmd.ts` — `decryptChromeCookiesMacOS`, `playwright/chromium`.
  - `packages/server/src/server.ts` — `./embedded-runtime` is statically imported, but `./server-lifecycle` is lazy: its transitive imports read env at module-eval, and the embedded branch only finalises DATABASE_URL during `main()`. Loading the lifecycle eagerly would snapshot a stale env.
  - `packages/server/src/embedded-runtime.ts` — `embedded-postgres` + `@lobu/pgvector-embedded` (and `postgres`) are lazy so the external/prod path (postgres:// URL) never resolves or loads the ~145MB embedded-Postgres binary even though it sits in node_modules. Only reached when DATABASE_URL is a path/file://.
  - **Tests** — `await import(...)` inside `beforeAll` / `beforeEach` / `test()` is allowed (load after `vi.mock(...)`); this is the vitest pattern, not a production exemption.

## Scope discipline and branch hygiene

- **One branch = one concern, but bundle related work.** Default to fewer, larger PRs as long as they stay reviewable. Split only when pieces are genuinely independent or unreviewable as one.
- **Tangential ask mid-branch:** commit + push current work, open the PR (draft if not ready), then `git switch main && git pull && git switch -c feat/<new-thing>`. If it genuinely builds on unmerged code, stack via `git switch -c feat/b feat/a` and target the parent PR.
- **Never `git stash`** — invisible, easy to lose, collides across agents. Use WIP commits (`git add -A && git commit -m "wip"`) and squash later.
- **Isolation:** parallel Claude Code sessions → `claude --worktree <name>`. Subagents that may `git switch`, commit, push, or run destructive commands MUST run with `isolation: "worktree"`. Read-only research can share the parent.
- **Cross-repo dispatch:** owletto changes go through `make task-setup`, which checks out owletto on a real branch (not a detached SHA). A plain isolation worktree inherits the parent's `.git` and pushes to the wrong remote. Bump the submodule pointer in lobu as a separate PR after the owletto merge.
- **Don't pass `"REPO: /absolute/path"` in dispatch prompts** — agents `cd` out of their isolation worktree onto the main checkout. Say "the lobu repo" / "the owletto repo" instead.

## Development

Prerequisites: Bun, Node.js **22.x–24.x** (`.nvmrc` and `.node-version` pin `22`), and a reachable Postgres (with `pgvector`) via `DATABASE_URL`. Node 25+ is rejected at boot — `isolated-vm` (used by `query_sdk` / `run_sdk`) has no Node 25+ build yet (upstream: [`laverdet/isolated-vm#553`](https://github.com/laverdet/isolated-vm/issues/553)).

Optional: `postgis` enables reverse-geocoding (used by `apple.photos`). Install via `./scripts/setup-local-postgis.sh`. Without it, lat/lng events skip `country` / `admin1` / `place_name` enrichment. For CloudNativePG (which lacks postgis), see `db/postgis/Dockerfile` + `scripts/build-postgis-image.sh`.

```bash
./scripts/setup-dev.sh   # first-time setup (builds packages, checks bun)
make dev                  # boots embedded gateway + workers + Vite HMR on :8787
make clean-workers        # kill orphaned worker subprocesses if a crash leaves any
```

For parallel worktrees, drop a gitignored `.env.local` with non-default ports (sourced after `.env`):

```bash
PORT=8788
WORKER_PROXY_PORT=8119
```

The Tailscale tunnel forwards one local port at a time — only the worktree on `:8787` is reachable at `https://...ts.net:8443`. Others use `http://localhost:8788` (fine for UI; webhook/OAuth-callback testing needs the public URL).

### Biome / IDE setup

Husky's pre-commit runs `biome check --write`. Configure your editor to format with `bunx biome check --write` on save (VS Code: official Biome extension; JetBrains: Biome plugin or a File Watcher). Without editor integration, `--write` still fixes at commit time — you just don't see the diff until `git status` surprises you.

### Validation after code changes

**After completing changes on a feature branch, run `make review`** — runs typecheck/unit/integration tests in cwd, calls local `pi` with the diff (`git diff main...HEAD`) and test results, prints a multi-axis JSON verdict (`bug_free_confidence`, `bugs`, `slop`, `simplicity`). If a PR exists for the current branch, also posts a PR comment with the verdict (marker-keyed upsert). Override the base with `BASE=<branch>` or `--base <branch>`. See `docs/REVIEW_SCHEMA.md`.

**E2E before merge (hard gate).** For bug-fix PRs, run red → fix → green: reproduce the failure (PGlite for SQL, gateway for SSE/runtime, binary for CLI), apply the fix, re-run, paste both outputs in the PR body under "Reproducer". **If you can't reproduce, BAIL** — post the dead-end on the issue, don't open a PR. Pi (`pi -p <PR>`) validates code shape, not whether the fix hits the smoking gun. Exception: native-app UI / hardware needing a human click — compile-checks still required, but say so in the PR body and leave it draft.

Run the validation that matches what you touched. All commands must exit 0; paste failures in the PR body. (`make dev` does not auto-rebuild workspace packages — run `make build-packages` after editing TS sources.)

| Change | Command |
| --- | --- |
| `packages/landing/*` | `cd packages/landing && bun run build` |
| `packages/{core,server,agent-worker,cli}/*` | `make build-packages` |
| `packages/owletto/apps/mac/*` | `cd packages/owletto/apps/mac && xcodebuild -project Owletto.xcodeproj -scheme Owletto -configuration Debug -destination "platform=macOS" build CODE_SIGNING_ALLOWED=NO` |
| Broad TS check | `bun run typecheck` |

For MCP work, verify tool calls against the gateway proxy or Lobu directly (e.g. via `bun -e`) before exercising the full agent loop.

For bot-behavior changes, run the test bot (dev: `@clawdotfreebot`, prod: `@lobuaibot`):

```bash
./scripts/test-bot.sh "@me test prompt"                     # single
./scripts/test-bot.sh "@me first" "follow up"               # multi-turn
TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot ./scripts/test-bot.sh "…"
```

If replies look stale, clear history: `psql "$DATABASE_URL" -c "DELETE FROM chat_state_lists WHERE key LIKE 'history:<connectionId>:%';"`

For prompt / behavior changes, run evals via [promptfoo](https://www.promptfoo.dev). Each example project ships `agents/<id>/evals/promptfooconfig.yaml` — see `examples/personal-finance/...` for the current pattern.

```bash
export LOBU_TOKEN=$(lobu token)
bun run evals          # promptfoo eval -c agents/<id>/evals/promptfooconfig.yaml
bun run evals:view     # comparison grid in the browser
```

For authenticated UI verification (signed-in flows past the auth wall), see [`docs/BROWSER_TESTING.md`](docs/BROWSER_TESTING.md) — recipe for minting a session cookie + driving `agent-browser`.

Don't `git switch` branches while a dev server is running — sibling worktrees can hide files your import graph still references and the server will refuse to boot. Use a detached HEAD off `origin/main` if you need a clean slate.

## Environment & Runtime

`.env` is the single source of truth for secrets. The gateway reads it on startup; restart `make dev` after changes. Worker sessions persist across restarts via `./workspaces/{agentId}/` (set as `cwd` + `WORKSPACE_DIR` on spawn).

Skills declare network needs (`networkConfig.allowedDomains`) and system tools (`nixPackages`); both merge into the agent's allowlist / Nix env on skill enable, with no per-skill approval prompt — **review skills before installing**. Destructive MCP tool calls still require in-thread approval unless pre-approved in `[agents.<id>.tools]` in `lobu.toml`.
