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

Scaffold a local agent project with `lobu.toml`, `.env`, and an agent directory.

```bash
npx @lobu/cli@latest init my-agent
```

Generates:

- `lobu.toml` — local project/apply/validate configuration
- `.env` — local environment variables (set `DATABASE_URL` after init)
- `agents/{name}/` — `IDENTITY.md`, `SOUL.md`, `USER.md`, local skills, and evals
- `skills/` — shared local skills directory
- `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`

Interactive prompts guide you through provider, platform, network access policy, gateway port, public URL, and memory configuration. Postgres (with pgvector) is the only user-provided external — Lobu does not bundle it.

---

### `run`

Run the embedded Lobu stack. `lobu.toml` is not required; set `DATABASE_URL` in the environment or `.env`, then run:

```bash
npx @lobu/cli@latest run
```

The command spawns the bundled Node server (`@lobu/server/dist/server.bundle.mjs`) and forwards stdio. Ctrl+C cleanly stops the server and worker subprocesses. Extra arguments are forwarded to the Node entry point.

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
npx @lobu/cli@latest context add staging --api-url https://staging.example.com/api/v1
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
npx @lobu/cli@latest chat "Status update" -c staging
```

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first agent in local `lobu.toml` when present) |
| `-u, --user <id>` | Route through a platform (e.g. `telegram:12345`, `slack:C0123`) |
| `-t, --thread <id>` | Thread/conversation ID for multi-turn conversations |
| `-g, --gateway <url>` | Gateway URL (default: `http://localhost:8787` or from `.env`) |
| `--dry-run` | Process without persisting history |
| `--new` | Force a new session |
| `-c, --context <name>` | Use a named context for gateway URL and credentials |

---

### `eval [name]`

Run local agent evaluations. Eval files live in the agent directory and define test cases with expected outcomes.

```bash
npx @lobu/cli@latest eval
npx @lobu/cli@latest eval basic-qa
npx @lobu/cli@latest eval --model claude/sonnet
npx @lobu/cli@latest eval --ci --output results.json
```

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first in local `lobu.toml`) |
| `-g, --gateway <url>` | Gateway URL (default: `http://localhost:8787`) |
| `-m, --model <model>` | Model to evaluate |
| `--trials <n>` | Override trial count |
| `--ci` | CI mode: JSON output, non-zero exit on failure |
| `--output <file>` | Write results to JSON file |
| `--list` | List available evals without running them |

---

### `validate`

Validate local `lobu.toml` schema, skill IDs, and provider configuration.

```bash
npx @lobu/cli@latest validate
```

Returns exit code `1` if validation fails.

---

### `apply`

Sync local `lobu.toml` and agent directories to a Lobu org.

```bash
npx @lobu/cli@latest apply --org my-org
npx @lobu/cli@latest apply --dry-run
```

---

### `status`

Show a summary of agents in the active org.

```bash
npx @lobu/cli@latest status
npx @lobu/cli@latest status --org my-org
```

---

### `logout`, `whoami`, `token`

```bash
npx @lobu/cli@latest whoami
npx @lobu/cli@latest token --raw
npx @lobu/cli@latest logout
```

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

# 4. Run locally when DATABASE_URL is configured
npx @lobu/cli@latest run
```
