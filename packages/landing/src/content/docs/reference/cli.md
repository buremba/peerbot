---
title: CLI Reference
description: Complete reference for the @lobu/cli command-line tool.
sidebar:
  order: 0
---

The Lobu CLI (`@lobu/cli`) scaffolds local project files, runs the embedded server, and manages org/agent configuration through the same REST API used by the web app.

## Install

```bash
# Run directly (no install)
npx @lobu/cli@latest <command>

# Or install globally
npm install -g @lobu/cli
lobu <command>
```

## Commands

### `init [name]`

Scaffold a local agent project with `lobu.config.ts`, `.env`, and an agent directory.

```bash
npx @lobu/cli@latest init my-agent
```

Generates:

- `lobu.config.ts`: the TypeScript project entrypoint (`defineConfig` from `@lobu/cli/config`)
- `package.json` + `tsconfig.json`: declare `@lobu/cli` / `@lobu/connector-sdk` and give the editor type resolution
- `.env` — local environment variables (API keys, optional external `DATABASE_URL`)
- `agents/{name}/` — `IDENTITY.md`, `SOUL.md`, `USER.md`, skill files, and evals
- `*.connector.ts` — custom connectors, referenced from `lobu.config.ts` via `connectorFromFile`
- `*.reaction.ts` — watcher reaction scripts, referenced via `defineWatcher({ reaction })`
- `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`

Interactive prompts guide you through provider, platform, network access policy, gateway port, public URL, and memory configuration. Local runs use an embedded Postgres (PG18 + pgvector) by default; set `DATABASE_URL` when you want to use an external Postgres.

---

### `run` (aliases: `dev`, `start`)

Run the embedded Lobu stack. `lobu.config.ts` is not required. With no `DATABASE_URL`, the command starts an embedded Postgres (PG18 + pgvector) and stores data under `~/.lobu/data` (override with `LOBU_DATA_DIR`). If `DATABASE_URL` is set in the environment or `.env`, Lobu uses that external Postgres instead.

```bash
npx @lobu/cli@latest run
npx @lobu/cli@latest run --port 9000
npx @lobu/cli@latest dev --verbose       # `dev` and `start` are aliases for `run`
```

| Flag | Description |
|------|-------------|
| `--port <port>` | Gateway port (overrides `GATEWAY_PORT` in `.env`) |
| `--quiet` | Suppress the startup banner; raise log level to `warn` |
| `--verbose` | Lower log level to `debug` |
| `--log-level <level>` | Forwarded as `LOG_LEVEL` to the bundled server |

The command spawns the bundled Node server and forwards stdio. Ctrl+C cleanly stops the server and worker subprocesses.

---

### `login`

Authenticate with Lobu via the OAuth 2.0 device-code flow. Prints a verification URL and opens it in the browser; you approve there and the CLI receives the token.

```bash
npx @lobu/cli@latest login
npx @lobu/cli@latest login --token <api-token>      # CI/CD
npx @lobu/cli@latest login -c staging               # login to a named context
npx @lobu/cli@latest login --force                  # re-authenticate
```

| Flag | Description |
|------|-------------|
| `--token <token>` | Use an API token directly |
| `-c, --context <name>` | Authenticate against a named context |
| `-f, --force` | Re-authenticate, revoking the existing OAuth session first |

---

### `context`

Manage named API contexts.

```bash
npx @lobu/cli@latest context list
npx @lobu/cli@latest context current
npx @lobu/cli@latest context add staging --url https://staging.example.com/api/v1
npx @lobu/cli@latest context use staging
```

Environment overrides: set `LOBU_CONTEXT` to select a context by name, or `LOBU_API_URL` to override the URL directly.

---

### `org`

Manage the active organization for org-scoped API commands.

```bash
npx @lobu/cli@latest org list
npx @lobu/cli@latest org current
npx @lobu/cli@latest org set my-org
```

`LOBU_ORG` overrides the active org for one process.

---

### `agent`

Manage agents via the same org-scoped REST endpoints as the web app.

```bash
npx @lobu/cli@latest agent list
npx @lobu/cli@latest agent get my-agent
npx @lobu/cli@latest agent create my-agent --name "My Agent"
npx @lobu/cli@latest agent update my-agent --description "Handles support"
npx @lobu/cli@latest agent delete my-agent --yes
```

`agent scaffold <agentId>` adds a new local agent (`agents/<id>/*` plus a `defineAgent` entry in `lobu.config.ts`) without touching existing agents, the local-files counterpart of `agent create`:

```bash
npx @lobu/cli@latest agent scaffold support-bot --name "Support Bot" --description "Handles tickets"
```

Config helpers use the web app's `/config` API:

```bash
npx @lobu/cli@latest agent config get my-agent --output config.json
npx @lobu/cli@latest agent config patch my-agent --file config.patch.json
```

Most agent commands accept `--org <slug>`, `-c/--context <name>`, and `--json` where useful.

---

### `chat <prompt>`

Send a prompt to an agent and stream the response to the terminal.

```bash
npx @lobu/cli@latest chat "What is the weather?"
npx @lobu/cli@latest chat "Hello" --agent my-agent --thread conv-123
npx @lobu/cli@latest chat "Check my PRs" --user telegram:12345
npx @lobu/cli@latest chat "Where did we leave off?" --continue
npx @lobu/cli@latest chat "Status update" -c staging
```

`-u/--user` impersonates a platform user ID (`telegram:<numeric-id>`, `slack:<member-id>`), which routes the message through that platform instead of replying directly in the terminal.

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first agent in local `lobu.config.ts` when present) |
| `-u, --user <id>` | User ID to impersonate, e.g. `telegram:12345`. With this flag the message routes through the user's platform (Telegram/Slack) |
| `-t, --thread <id>` | Thread/conversation ID for multi-turn conversations |
| `-g, --gateway <url>` | Gateway URL (default: `http://localhost:8787` or from `.env`) |
| `--dry-run` | Process without persisting history |
| `--new` | Force a new session (ignore an existing one) |
| `-C, --continue` | Resume the last thread for this `(context, agent)` |
| `--auto-approve` | Auto-approve every tool call — use only in trusted environments |
| `--json` | Emit raw SSE events as JSON lines instead of rendered text |
| `-c, --context <name>` | Use a named context for gateway URL and credentials |

---

### Evaluations

Lobu does not ship its own eval runner. Use [promptfoo](https://www.promptfoo.dev) with [`@lobu/promptfoo-provider`](https://www.npmjs.com/package/@lobu/promptfoo-provider); see the [Evaluations guide](/sdks/evals/) for the full pattern.

```bash
bun add -D promptfoo @lobu/promptfoo-provider
LOBU_TOKEN=$(npx @lobu/cli@latest token) \
  bunx promptfoo eval -c agents/<agent-id>/evals/promptfooconfig.yaml
```

---

### `validate`

Validate that local `lobu.config.ts` loads and conforms to the schema, plus skill IDs and provider configuration.

```bash
npx @lobu/cli@latest validate
```

Returns exit code `1` if validation fails.

---

### `apply` (alias: `deploy`)

Sync local `lobu.config.ts` and agent directories to a Lobu Cloud org. Idempotent, prompt-confirmed, one-way (files are the source of truth).

```bash
npx @lobu/cli@latest apply                  # plan + prompt + apply
npx @lobu/cli@latest apply --dry-run         # plan only, no mutations
npx @lobu/cli@latest apply --yes --org my-org   # CI mode, no prompt
npx @lobu/cli@latest deploy --only agents    # `deploy` is an alias
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show the plan and exit without mutating |
| `--yes` | Skip the confirmation prompt (CI mode) |
| `--only <kind>` | Restrict to one resource family: `agents` or `memory` |
| `--org <slug>` | Org slug override (defaults to the active session) |
| `--url <url>` | Server URL override |
| `--force` | Bypass the project-link guard if `context`/`org` don't match `.lobu/project.json` |

See [`lobu apply`](/reference/lobu-apply/) for the full flow — plan output, apply order, stable platform IDs, drift, and required-secret checks.

---

### `status`

Show a summary of agents in the active org.

```bash
npx @lobu/cli@latest status
npx @lobu/cli@latest status --org my-org
```

---

### `link` / `unlink`

`link` binds the current directory to a `(context, org)` pair, written to `.lobu/project.json`. Subsequent commands in this directory default to that context and org, and `lobu apply` refuses to run against a different pair unless you pass `--force`. `unlink` removes the file.

```bash
npx @lobu/cli@latest link --org my-org
npx @lobu/cli@latest link -c staging --org my-org
npx @lobu/cli@latest unlink
```

| Flag | Description |
|------|-------------|
| `-c, --context <name>` | Use a named context |
| `--org <slug>` | Org slug to link (defaults to the active org) |

---

### `doctor`

Run local health checks: dependencies, `DATABASE_URL` reachability, pgvector, ports, and provider keys.

```bash
npx @lobu/cli@latest doctor
npx @lobu/cli@latest doctor --memory-only      # only check memory MCP connectivity + auth
```

| Flag | Description |
|------|-------------|
| `--memory-only` | Only check memory MCP connectivity and authentication |

---

### `telemetry`

Show or toggle anonymous error reporting (Sentry). With no subcommand, prints the current status.

```bash
npx @lobu/cli@latest telemetry            # same as `telemetry status`
npx @lobu/cli@latest telemetry status
npx @lobu/cli@latest telemetry on         # writes SENTRY_DSN to .env
npx @lobu/cli@latest telemetry on --dsn https://...@sentry.example.com/1
npx @lobu/cli@latest telemetry off        # removes SENTRY_DSN from .env
```

| Subcommand | Description |
|------------|-------------|
| `status` | Show whether telemetry is on or off (default) |
| `on` | Enable telemetry — accepts `--dsn <dsn>` to override Lobu's default DSN |
| `off` | Disable telemetry |

---

### `logout`, `whoami`, `token`

```bash
npx @lobu/cli@latest whoami
npx @lobu/cli@latest token --raw
npx @lobu/cli@latest logout
```

`token` (no subcommand) prints the stored session token. `token create` mints an **org-scoped personal access token** suitable for servers and CI — it survives a `lobu logout` and is not tied to the device-code session:

```bash
npx @lobu/cli@latest token create --org my-org --name ci-token --scope "mcp:read mcp:write" --expires-in-days 90
npx @lobu/cli@latest token create --org my-org --raw      # token only, for scripting
npx @lobu/cli@latest token create --org my-org --json
```

| Flag | Description |
|------|-------------|
| `--org <slug>` | Org slug override |
| `--name <name>` | Token name (default: `lobu-cli-YYYY-MM-DD`) |
| `--description <text>` | Token description |
| `--scope <scope>` | Space-separated scopes (default: `mcp:read mcp:write`) |
| `--expires-in-days <days>` | Expire the token after N days (positive integer) |
| `--raw` | Print the token only, no labels |
| `--json` | Print the full JSON response |
| `-c, --context <name>` | Use a named context |

## Typical workflow

```bash
# 1. Authenticate and select org
npx @lobu/cli@latest login
npx @lobu/cli@latest org set my-org

# 2. Manage remote/UI-backed agents
npx @lobu/cli@latest agent list
npx @lobu/cli@latest agent create my-agent --name "My Agent"

# 3. Optional local artifact workflow
npx @lobu/cli@latest init my-agent
cd my-agent
npx @lobu/cli@latest validate
npx @lobu/cli@latest apply --org my-org

# 4. Run locally (embedded Postgres by default; external Postgres if DATABASE_URL is set)
npx @lobu/cli@latest run
```
