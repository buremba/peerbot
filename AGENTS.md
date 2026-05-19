## Project Structure & Module Organization

### Package Architecture
- **`packages/core`**: Shared code between gateway and worker (interfaces, utils, types). Any code reused by both must live here.
- **`packages/server`**: Embedded server plus platform-agnostic gateway. Gateway platform connections live in `src/gateway/connections/`; orchestration lives under `src/gateway/orchestration/`.
- **`packages/agent-worker`**: Agent execution via OpenClaw runtime in `src/openclaw/`. Worker talks only to gateway and agent. No platform knowledge.

### Module Boundaries
- Gateway: Connections → `src/gateway/connections/`, orchestration → `src/gateway/orchestration/`, Slack OAuth routes → `src/gateway/routes/public/slack.ts`
- Worker: Platform-agnostic, agent logic isolated to `src/openclaw/`
- Core: Shared interfaces, utils, types for gateway+worker
- **Platform isolation**: InteractionService events (e.g. `link-button:created`) carry an explicit `platform` field. Each platform renderer MUST filter on its own platform identity (`platform === "telegram"`, `platform === "slack"`). Never reference another platform's identifier.

### Repository Layout
- Monorepo managed by Bun workspaces under `packages/*`.
- Top-level: `Makefile`, `scripts/`, `config/`, `docs/` (RELEASING, SECURITY), `.env*`.
- TypeScript sources in `packages/*/src`, tests in `packages/*/src/__tests__`.
- Always prefer `bun` over `npm`.
- When fixing unused-parameter errors, delete the parameter rather than prefixing with `_`.

### Submodules
`packages/owletto` is a submodule of `lobu-ai/owletto`. Push the submodule change to a reachable branch first (usually `main`), then bump the pointer in the parent — the parent must never point at an unreachable SHA, or production cloning will fail.

### Frontend (owletto)
When editing UI under `packages/owletto`, follow the design rules in @packages/owletto/DESIGN_GUIDELINES.md — confirmations, surfaces, empty states, selection, forms, page copy, radius, Sheet vs Dialog. Match the existing components and exemplar files referenced there; do not introduce new primitives without updating the guideline in the same PR.

### Architecture

#### Platform
All chat platforms (Telegram, Slack, Discord, WhatsApp, Teams) run through Chat SDK adapters in `packages/server/src/gateway/connections/`. Connections are created via the `/agents` admin UI or the connections CRUD API — no per-platform env vars. Each connection has a typed config schema (bot token for Telegram, signing secret + bot token for Slack, etc.). Gateway also exposes a public endpoint that triggers an agent run. Settings-page provider order is drag-sortable, with per-provider model selection inline.

**Webhooks via the Chat SDK adapter are the default transport.** Don't add new per-platform alternative transports (Slack Socket Mode, Discord Gateway WebSocket bridges, etc.) or extra runtime SDKs. The lone exception is Telegram, whose connection config exposes an optional `polling` mode (`mode: "auto" | "webhook" | "polling"`) implemented inside the Chat SDK adapter — still no extra SDK. Local dev for webhook-only platforms uses a tunnel (cloudflared / ngrok / Tailscale Funnel); Lobu Cloud users get a public URL for free. Sticking to the Chat SDK keeps one delivery story, one set of retries, and zero extra dependencies.

`mode: "polling"` is rejected at connection-create time when `LOBU_CLOUD_MODE=1` — a polling worker long-polls Telegram's edge from the gateway pod and shares that connection across tenants, so a misbehaving polling connection in one org degrades delivery for every other tenant. Self-hosters (`LOBU_CLOUD_MODE` unset/0) keep the polling option for tunnel-less dev.

#### Orchestration
- **Embedded-only deployment.** Gateway, workers, embeddings, and the Lobu memory backend run in a single Node process (`lobu run`, or `bun run dev` in the monorepo). Workers spawn as `child_process.spawn` subprocesses on the same host; on Linux the spawn path uses `systemd-run --user --scope` for cgroup limits + IPAddressDeny + capability drops. There is no Docker or Kubernetes deployment manager.
- Postgres (with `pgvector`; optionally `postgis` for geo enrichment) is the only user-provided external. The Node process connects out via `DATABASE_URL`. Runtime state — queues, chat connection rows, grant cache, MCP proxy sessions — lives in dedicated Postgres tables.
- Workers are sandboxed and **never see real credentials**. The gateway's `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real keys at egress; workers receive only the placeholders.

#### MCP
- Bundled LLM providers come from `config/providers.json`; MCP servers come from per-agent settings or local `SKILL.md` files.
- Workers discover MCP tools at startup and register them as first-class agent tools (direct function calls, not curl instructions).
- Workers call MCP tools via the gateway proxy using their JWT.
- Built-in MCPs: `AskUser` (request user input), `UploadFile` (share files with user).
- **Integration auth lives in Lobu** — OAuth, token refresh, and API proxying for third-party services (GitHub, Google, etc.) are handled by Lobu MCP servers. Workers never see OAuth tokens.
- **`events` is append-only.** Never `DELETE FROM events`. To hide a row, insert a tombstone event whose `supersedes_event_id` points at it — the `current_event_records` view filters out anything that has a newer superseder, and `include_superseded` recovers history. `client.knowledge.delete()` and `save_knowledge({ supersedes_event_id, ... })` are the only sanctioned write paths for "removing" content.

#### Guardrails
- Primitive lives in `packages/core/src/guardrails/`: `Guardrail<stage>`, `GuardrailRegistry`, `runGuardrails()`. Stages: `input` (user message → worker), `output` (worker text → user), `pre-tool` (tool call authorization).
- Each guardrail's `run(ctx)` returns `{ tripped, reason?, metadata? }`. The runner races all enabled guardrails at a stage; the first trip short-circuits (later results are discarded) and a thrown guardrail is logged and treated as a pass.
- Built-ins ship from `packages/server/src/gateway/guardrails/builtins.ts` and are wired during `CoreServices.initialize`:
  - `secret-scan` (output) — regex scan for OpenAI keys (`sk-…`), GitHub PATs (`ghp_…`), AWS access keys (`AKIA…`), JWT-shaped tokens. Cheap enough to run per streaming delta.
  - `pii-scan` (input / output / pre-tool) — regex sweep for emails, US-shaped phones, and Luhn-valid 13–19 digit card-shaped runs across the user message, worker output, or serialized pre-tool args.
  - `forbidden-tools` (pre-tool) — hardcoded deny-list (`delete_repo`, `delete_branch`, `drop_table`).
- `createNoopGuardrail(stage, name?)` remains a template for downstream packages (prompt-injection classifier, custom PII scrubbers, etc.) that call `registry.register(...)` after `getCoreServices().getGuardrailRegistry()`.

##### Configuration

Three places guardrails can be turned on for an agent — all merged by `resolveAgentGuardrails()` in `packages/server/src/gateway/guardrails/aggregator.ts`:

1. **Agent built-in list** (all stages):
   ```toml
   [agents.<id>]
   guardrails = ["pii-scan", "prompt-injection"]
   ```
2. **Agent inline judges** — ad-hoc LLM-judge guardrails, no registry lookup:
   ```toml
   [[agents.<id>.guardrails_inline]]
   stage = "output"
   judge = "Never mention competitors."

   [[agents.<id>.guardrails_inline]]
   stage = "pre-tool"
   tools = ["github.delete_repo"]
   judge = "Only allow when the issue ref matches the active sprint."
   ```
   Each materializes into a guardrail named `inline:<stage>:<hash8>` (sha256 of the policy text). `tools` narrows pre-tool to a list of tool names; omitted = runs on every tool call.
3. **Skill-declared guardrails** — **`pre-tool` only**. Skills don't own `input` / `output`: a skill can't decide for the operator which messages reach which agent or which words the agent may speak. `pre-tool` is scoped to specific tool invocations, which is what a skill knows about. Each entry is a discriminated union (`{ kind: "builtin" | "judge" }`) so neither/both is a TS error, not a runtime log:
   ```ts
   guardrails: {
     "pre-tool": [
       { kind: "builtin", name: "pii-scan" },
       { kind: "judge", policy: "Reject writes outside the workspace.", tools: ["fs.write"] },
     ],
   }
   ```
   Skill inline judges are named `skill:<skillName>:inline:pre-tool:<hash8>`. `tools` narrowing is only available on the `judge` arm — built-ins do their own input filtering, so per-tool narrowing for them would silently lie about scope.

##### Operator exclude list

```toml
[agents.<id>]
guardrails_disabled = ["pii-scan", "skill:secret-lookup:inline:pre-tool:1a2b3c4d"]
```

Names match the resolved `Guardrail.name` — including the synthesized inline names. Applied last, after the merge. Use this to turn off a guardrail a skill auto-attaches without un-installing the skill.

##### LLM judge engine

`createJudgeGuardrail(stage, policy, options?)` from `packages/server/src/gateway/guardrails/judge-factory.ts` wraps `TextJudge` (extracted from the egress judge — same Haiku client, 5-min verdict cache keyed by `(policyHash, textHash)`, circuit breaker 5 failures → 30s cooldown, fail closed). Requires `ANTHROPIC_API_KEY` at the gateway. Reuses the egress judge's primitives so behavior is identical: cache, breaker, timeout, fail-closed posture.

##### Runtime wiring

- Wired call sites: `MessageConsumer.handleMessage` (input), `ChatResponseBridge.handleDelta` (output, runs per streaming delta), and `McpProxy.handleProxyRequest` (pre-tool, before the approval check). All three fail open on infrastructure errors — guardrails are a safety net, not a hard dependency.
- Trip handling per stage:
  - **Input** → dispatch is skipped and `Message rejected: <reason>` is pushed to the `thread_response` queue so the user sees a rejection in-thread.
  - **Output** → the in-flight platform stream is disposed, `Message blocked by guardrail: <reason>` is posted, and the rest of the worker's stream for that conversation is suppressed. The partial buffer is NOT written to history.
  - **Pre-tool** → the worker receives a JSON-RPC `isError: true` reply with the literal text `Tool call blocked by policy.`. The specific reason is intentionally NOT surfaced to the worker — leaking it is an evasion surface.
- Every trip writes one `events` row with `semantic_type='guardrail-trip'`, `origin_type='guardrail-<stage>'`, and metadata `{guardrail, stage, reason, agent_id, user_id, conversation_id, guardrail_metadata?}`. Append-only — operators can dashboard these in the same place lifecycle events live.

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
Skills and agents can route risky domains through an LLM judge instead of a flat allow/deny. Hooks into the same HTTP proxy at `packages/server/src/gateway/proxy/http-proxy.ts`; invoked only when a `judgedDomains` rule matches, so most traffic bypasses the judge.

- Skill YAML declares judged domains + named policies:
  ```yaml
  network:
    allow: [api.readonly.example.com]
    judge:
      - { domain: "*.slack.com" }                      # uses "default"
      - { domain: "user-content.x.com", judge: strict }
  judges:
    default: "Allow only reads to channels in the agent's context."
    strict:  "Only GET for file IDs from the current session."
  ```
- Operator appends policy in `lobu.toml`:
  ```toml
  [agents.<id>.egress]
  extra_policy = "Never exfiltrate PATs or bearer tokens."
  judge_model  = "claude-haiku-4-5-20251001"
  ```
- Defaults: Haiku (`claude-haiku-4-5-20251001`), 5 min verdict cache keyed by `(policyHash, request signature)`, circuit breaker opens after 5 consecutive judge failures (30s cooldown) and fails closed.
- Requires `ANTHROPIC_API_KEY` in the gateway env. Gateways with no judged-domain rules never construct the client.
- Hostname-only for HTTPS CONNECT (TLS tunnel is opaque); method + path available for plain HTTP.
- Audit: every decision is logged as a structured `egress-decision` log record with verdict, source (`global | grant | judge`), judge source (`judge | cache | circuit-open`), latency, and policy hash. No request bodies/headers are logged.

## TypeScript Build System

TypeScript packages must be compiled from `src/` → `dist/`. If you modify any package source code, run `make build-packages`. `make dev` (`scripts/dev-native.sh`) does not auto-rebuild workspace packages — it loads them from disk via the `bun` resolution condition.

## Versioning and releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please): land conventional commits on `main`, merge the generated release PR, and CI publishes to npm (OIDC). See [`docs/RELEASING.md`](docs/RELEASING.md) for the full flow, recovery playbook, and local-publish fallback.

Rules for agents:
- Inter-package deps MUST be `"@lobu/<name>": "workspace:*"` — never a hardcoded version. `scripts/publish-packages.mjs` rewrites them at publish time.
- Don't hand-edit `packages/*/package.json` versions and don't push `chore(release)` commits directly; release-please owns those.
- Source of truth for the current version: `.release-please-manifest.json` plus the `v<version>` tags.

## Agent Rules
- Do only what's asked — nothing more, nothing less.
- Don't create `*.md` files unless explicitly asked. Add memory to `CLAUDE.md` as a single sentence.
- Delete any ephemeral files you create.
- Ignore `/dist/` — compiled artifacts, not source.
- After editing `packages/agent-worker/*`, run `make clean-workers` so new workers pick up the change.
- When the user pastes a Slack link (`slack.com/archives/…?thread_ts=`), call `./scripts/slack-thread-viewer.js "<link>"` first.
- In planning mode, when unsure, ask: `codex exec "QUESTION" --config model_reasoning_effort="high"`.

## Scope discipline and branch hygiene

When the user pivots mid-session, the default failure mode is piling unrelated work onto one branch and producing a tangled PR. Prevent that:

- **One branch = one concern, but bundle related work.** Never mix unrelated features on a single branch — but don't fragment one concern into a stack of tiny PRs either. Default to fewer, larger PRs as long as they stay reviewable. Split only when (a) the changes are genuinely independent, (b) the diff would be unreviewable as one piece, or (c) one piece is independently shippable and blocking it on the rest costs real time.
- **When the user asks for something tangential to the current branch**, stop and say out loud: *"that's a separate concern — I'll finish/push the current work and start a fresh branch."* Then:
  1. Commit and push what you have.
  2. Open the PR for the current branch (or leave it draft if not ready).
  3. `git switch main && git pull && git switch -c feat/<new-thing>` before touching any new code.
- **When the new ask genuinely builds on unmerged code**, stack it: `git switch -c feat/b feat/a` off the existing feature branch and open PR #2 targeting `feat/a` (not `main`). Rebase PR #2 onto `main` once PR #1 merges.
- **Never `git stash`.** Stashes are invisible, easy to lose, and collide across agents. If you need to pivot without finishing, commit WIP to the current branch (`git add -A && git commit -m "wip"`) and squash later. WIP commits are visible, pushable, recoverable.
- **`~/Code/lobu` is read-only for agents.** All writes — commits, branch creation, submodule bumps, even one-line build fixes — go through a `make task-setup NAME=<slug>` worktree. For the trivial "advance a submodule pointer" case, `make bump SUBMODULE=<path> [TARGET=<ref>]` is the lightweight shortcut (skips bun install, .env copy, port allocation). The main checkout staying on `main` is the invariant that lets other agents `git worktree add` cleanly — leaving it on `chore/some-fix` silently breaks every parallel agent's `task-setup`.
- **Per-agent isolation:** when launching a parallel Claude Code session, use `claude --worktree <name>` so each agent gets its own checkout + branch. No shared working dir = no cross-agent collisions.
- **Subagent isolation (mandatory):** any spawned subagent that may `git switch`, commit, push, or run a destructive command MUST run with `isolation: "worktree"`. Read-only research/exploration agents may share the parent checkout. If unsure, use a worktree — the cost is a temp checkout, the cost of skipping is overwriting the user's working tree.
- **Cross-repo dispatch:** owletto changes go through a `make task-setup NAME=<slug>` worktree, which fetches a fresh owletto checkout under `.claude/worktrees/<slug>/packages/owletto` on a real branch (not a detached submodule SHA). The submodule worktree inherits the parent's `.git` and pushes to the wrong remote; an isolation worktree of lobu that needs to edit owletto code ends up with `origin = lobu-ai/owletto` and can't push to lobu. After an owletto PR merges, bump the submodule pointer in lobu in a separate small PR.
- **Don't pass `"REPO: /absolute/path"` in dispatch prompts.** Agents take it as a cwd directive and `cd` out of their isolation worktree onto the main checkout. Say "the lobu repo" / "the owletto repo" instead and let `isolation: "worktree"` do its job.
- **If a branch has already gotten mixed**, recover with `git rebase -i` + `git reset HEAD~N` and re-commit in clean groups before opening PRs.

## Development

Prerequisites: Bun, Node.js **22.x–24.x** (`.nvmrc` and `.node-version` pin `22`), and a reachable Postgres (with `pgvector`) via `DATABASE_URL`. Node 25+ is rejected at boot — `isolated-vm` (used by `query_sdk` / `run_sdk`) has no Node 25+ build yet (upstream: [`laverdet/isolated-vm#553`](https://github.com/laverdet/isolated-vm/issues/553)).

Optional: `postgis` for reverse-geocoding events with lat/lng (currently used by `apple.photos`). For a one-shot local install run `./scripts/setup-local-postgis.sh` — it checks whether the server has the postgis extension available, prints the OS-specific `brew`/`apt` command if not, then runs `CREATE EXTENSION postgis;` and seeds the GeoNames reference tables. To do the steps by hand: install the `postgresql-NN-postgis-3` (or Homebrew `postgis`) package, `CREATE EXTENSION postgis;` as superuser, and run `scripts/seed-geo-data.sh`. Without `postgis` the migration becomes a no-op and runtime enrichment silently skips — events keep their raw `latitude`/`longitude` and just don't get `country` / `admin1` / `place_name` filled.

For CloudNativePG clusters specifically, the stock `ghcr.io/cloudnative-pg/postgresql` image doesn't include `postgis` and CNPG hasn't published a postgis variant for PG 18+ yet. `db/postgis/Dockerfile` + `scripts/build-postgis-image.sh` bake `postgresql-N-postgis-3` on top of the base CNPG image and push to a registry (`ghcr.io/lobu-ai/postgres-postgis:<pg>-postgis-3` by default). Point the CNPG `Cluster.spec.imageName` at the result; CNPG rolls the pod, then `CREATE EXTENSION postgis;` as the `postgres` superuser inside the pod (`kubectl exec -n <ns> <cluster>-1 -c postgres -- psql -U postgres -d <db> -c '...'`) finalises it. When CNPG ships an official PG 18 postgis variant, drop the custom image and switch back.

```bash
./scripts/setup-dev.sh   # first-time setup (builds packages, checks bun)
make dev                  # boots embedded gateway + workers + Vite HMR on :8787
make clean-workers        # kill orphaned worker subprocesses if a crash leaves any
```

To run multiple worktrees in parallel, drop a gitignored `.env.local` in each
worktree's repo root with non-default ports — it's sourced after `.env` so it
overrides:

```bash
# packages/lobu-other-worktree/.env.local
PORT=8788
WORKER_PROXY_PORT=8119
```

The Tailscale tunnel only forwards to one local port at a time, so whichever
worktree owns `:8787` is what `https://...ts.net:8443` serves. Other worktrees
are reachable on `http://localhost:8788` etc. — fine for UI work; only
webhook/OAuth-callback testing actually needs the public URL.

### bun lockfile + owletto submodule

CI initialises `packages/owletto` via the deploy key before `bun install --frozen-lockfile`, so the lockfile that lands on `main` always reflects an *initialised* submodule. Locally, `bun install --frozen-lockfile` only matches that state if your checkout also has the submodule initialised — an uninitialised submodule prunes the owletto half of the dependency graph and Bun rewrites the lockfile, which then fails CI's frozen check on the next push.

Before pushing changes that touch `bun.lock` or any `package.json`, run:

```bash
git submodule update --init packages/owletto
bun install --frozen-lockfile
```

If the second command rewrites `bun.lock`, that's the drift CI would have caught — commit the regenerated lockfile in the same change.

### Biome / IDE setup

Husky's pre-commit hook runs `biome check --write`, so the canonical formatter is biome and not whatever your editor ships by default. To keep your editor and the hook from fighting:

- **VS Code:** install the official [Biome extension](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) and set it as the default formatter for TS/JS/JSON in workspace settings.
- **JetBrains (WebStorm/IDEA):** install the Biome plugin, *or* wire a File Watcher that runs `bunx biome check --write $FilePath$` on save.
- **Other editors:** point your save-time formatter at `bunx biome check --write` so the pre-commit hook's auto-fixes match what's already on disk.

Without an editor integration, biome's `--write` still rewrites files at commit time — you just don't see the diff until `git status` surprises you.

### Validation after code changes

**E2E before merge (hard gate).** For any bug-fix PR, do a red → fix → green cycle before opening:

1. Reproduce the failure first (boot PGlite for SQL bugs, the gateway for SSE/runtime bugs, the actual binary for CLI bugs). Capture output.
2. Apply the fix.
3. Re-run the reproducer. Capture output.
4. Paste both in the PR body under a "Reproducer" section.
5. **If you can't reproduce the original failure, BAIL** — post the dead-end on the issue, do not open a PR. Pi (the project's automated PR-review CLI, run as `pi -p <PR>`) validates code shape, not that the fix hits the actual smoking gun.

Exception: runtime/UI validation on native apps (Mac/iOS) or hardware that needs a human-driven click. Compile-checks aren't exempt — `xcodebuild` runs headlessly. If you can't drive the UI, say so explicitly in the PR body ("Compiled clean; UI flow needs human validation") and leave the PR in draft.

Run the validation that matches what you touched:

| Change | Command |
| --- | --- |
| `packages/landing/*` | `cd packages/landing && bun run build` |
| `packages/{core,server,agent-worker,cli}/*` | `make build-packages` |
| `packages/owletto/apps/mac/*` | `cd packages/owletto/apps/mac && xcodebuild -project Owletto.xcodeproj -scheme Owletto -configuration Debug -destination "platform=macOS" build CODE_SIGNING_ALLOWED=NO` |
| Broad TS check | `bun run typecheck` |

For MCP work, verify tool calls against the gateway proxy or Lobu directly (e.g. via `bun -e`) before exercising the full agent loop.

If the change affects bot behavior, run the test bot:

```bash
./scripts/test-bot.sh "@me test prompt"              # single
./scripts/test-bot.sh "@me first" "follow up"        # multi-turn
# Telegram: TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot ./scripts/test-bot.sh "…"
```

If replies look stale, clear chat history rows directly in Postgres. Chat history lives in the Chat SDK state-adapter tables under the `history:<connectionId>:<channelId>` key:

```bash
psql "$DATABASE_URL" -c "DELETE FROM chat_state_lists WHERE key LIKE 'history:<connectionId>:%';"
```

For prompt / behavior changes, run evals via [promptfoo](https://www.promptfoo.dev) + the `@lobu/promptfoo-provider` package. Each example project ships its own `agents/<id>/evals/promptfooconfig.yaml`. From the project directory:

```bash
export LOBU_TOKEN=$(lobu token)
bun run evals          # promptfoo eval -c agents/<id>/evals/promptfooconfig.yaml
bun run evals:view     # comparison grid in the browser
```

See `examples/personal-finance/agents/personal-finance/evals/promptfooconfig.yaml` for the current pattern (`@lobu/promptfoo-provider` loaded via promptfoo's `package:` protocol, single-turn parametric tests, answer-quality + behavioural assertions). The in-house YAML eval runner (`lobu eval`) has been removed.

Local dev Telegram bot: `@clawdotfreebot`. Production: `@lobuaibot`.

### Browser-driven verification (authenticated)

For any UI verification that needs a signed-in session (anything past the auth wall), use the `agent-browser` CLI with a session cookie minted from the DB. The user's regular Chrome doesn't expose a remote-debug port, so `--auto-connect` will land on a wrong tab; mint a cookie instead.

**Scope of this recipe.** The forged session cookie authenticates the **web admin REST mounted at `/`** (`/api/auth/*`, `/api/<orgSlug>/...`, the SPA — anything `lobu apply` and the web app talk to). It does **NOT** authenticate the **public Agent API at `/lobu`** (`/lobu/api/v1/agents/*`, `/lobu/api/v1/agents/<id>/sessions`) — that path expects a JWT bearer token from the OAuth device flow (`lobu login`) or a PAT. If `/lobu/api/v1/agents` returns `401 Unauthorized` despite a valid cookie, that's why; switch to `lobu chat` / `lobu token` to talk to the Agent API.

**Pick a target.** Local dev backend (with prod DB attached over Tailscale) is reachable at `https://buraks-macbook-pro-1.brill-kanyu.ts.net:8443` — use this when you only need to verify behavior end-to-end without a fresh prod deploy. For prod itself use `https://app.lobu.ai`.

**Grab the secret + a session token.**

```bash
# Local dev backend uses .env's BETTER_AUTH_SECRET
SECRET=$(grep '^BETTER_AUTH_SECRET=' .env | cut -d= -f2-)

# Prod uses the secret on the K8s pod
SECRET=$(kubectl exec -n summaries-prod \
  $(kubectl get pod -n summaries-prod -l app.kubernetes.io/name=lobu-app -o name | head -1 | sed 's|pod/||') \
  -- printenv BETTER_AUTH_SECRET)

# Session token comes from the DB (prod DB serves both targets)
DB="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
TOKEN=$(psql "$DB" -tAc "SELECT token FROM session WHERE \"userId\" = '<user_id>' AND \"expiresAt\" > NOW() ORDER BY \"updatedAt\" DESC LIMIT 1")
```

**Sign the cookie** (better-auth uses HMAC-SHA256, base64, then URL-encode — base64**url** does *not* validate):

```bash
SIGNED=$(SECRET="$SECRET" TOKEN="$TOKEN" node -e '
  const {createHmac}=require("node:crypto");
  const sig=createHmac("sha256",process.env.SECRET).update(process.env.TOKEN).digest("base64");
  console.log(encodeURIComponent(`${process.env.TOKEN}.${sig}`));
')
```

**Cookie name** is `__Secure-better-auth.session_token` whenever the baseURL is `https://` (both prod and the Tailscale dev URL qualify; only plain-http localhost uses the unprefixed `better-auth.session_token`).

**Drive the browser:**

```bash
agent-browser --session lobu-verify open "https://app.lobu.ai/"
agent-browser --session lobu-verify eval "document.cookie='__Secure-better-auth.session_token=$SIGNED; path=/; secure; samesite=lax'"
agent-browser --session lobu-verify open "https://app.lobu.ai/<path>"
agent-browser --session lobu-verify wait --text "<expected text>" --timeout 25000
agent-browser --session lobu-verify snapshot -i      # find @refs
agent-browser --session lobu-verify click @e13        # interact
agent-browser --session lobu-verify screenshot --full /tmp/out.png   # capture
agent-browser --session lobu-verify close
```

Don't `git stash`/`git switch` to a different branch while a dev server is running — sibling worktrees on neighbouring branches can hide files (e.g. `gateway/auth/cli/token-service.ts`) that your import graph still references, and the server will refuse to boot. Verify on a detached HEAD off `origin/main` if you need a clean slate.

## Environment & Runtime

`.env` is the single source of truth for secrets. The gateway reads it on startup; restart `make dev` after changes.

Worker sessions persist across restarts via host-mounted workspaces under `./workspaces/{agentId}/`. Workers spawn from `EmbeddedDeploymentManager` as `child_process.spawn` subprocesses with that directory as their `cwd` and `WORKSPACE_DIR` env. On Linux production hosts, the manager wraps the spawn in `systemd-run --user --scope` to add MemoryMax/CPUQuota/IPAddressDeny + capability drops; on macOS the plain spawn path runs.

### Integration authentication

OAuth for third-party APIs (GitHub, Google, Linear, etc.) is handled by **Lobu**, not the gateway. Workers hit those APIs through Lobu MCP tools and never see tokens directly.

Skills that need network declare `networkConfig.allowedDomains`; skills that need system tools declare `nixPackages`. Both are merged into the agent's allowlist / Nix env when the skill is enabled, with no per-skill approval prompt — review skills before installing. Destructive MCP tool calls still require in-thread approval unless pre-approved in `[agents.<id>.tools]` in `lobu.toml`.
