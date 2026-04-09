---
title: CLI Reference
description: Complete reference for the @lobu/cli command-line tool.
sidebar:
  order: 0
---

The Lobu CLI (`@lobu/cli`) scaffolds projects, runs agents locally, and manages deployments.

## Install

```bash
# Run directly (no install)
npx @lobu/cli <command>

# Or install globally
npm install -g @lobu/cli
lobu <command>
```

## Commands

### `init [name]`

Scaffold a new agent project with `lobu.toml`, Docker Compose, and environment config.

```bash
npx @lobu/cli init my-agent
```

Generates:

- `lobu.toml` — agent configuration (skills, providers, connections, network)
- `docker-compose.yml` — service definitions (gateway, Redis, optional Owletto)
- `.env` — credentials and environment variables
- `agents/{name}/` — agent directory with `IDENTITY.md`, `SOUL.md`, `USER.md`, and `skills/`
- `skills/` — shared skills directory (available to all agents)
- `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`
- `Dockerfile.worker` — worker image customization (Docker mode only)

Interactive prompts guide you through deployment mode, provider, skills, platform, network access policy, gateway port, public URL, admin password, and memory configuration.

---

### `chat <prompt>`

Send a prompt to an agent and stream the response to the terminal.

```bash
npx @lobu/cli chat "What is the weather?"
npx @lobu/cli chat "Hello" --agent my-agent --thread conv-123
npx @lobu/cli chat "Check my PRs" --user telegram:12345
npx @lobu/cli chat "Status update" -c staging
```

**API mode** (default): creates a session, sends the message, and streams the response to the terminal.

**Platform mode** (with `--user`): routes the message through Telegram/Slack/Discord so the response appears on the platform. The terminal also streams the output.

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first agent in `lobu.toml`) |
| `-u, --user <id>` | Route through a platform (e.g. `telegram:12345`, `slack:C0123`) |
| `-t, --thread <id>` | Thread/conversation ID for multi-turn conversations |
| `-g, --gateway <url>` | Gateway URL (default: `http://localhost:8080` or from `.env`) |
| `--dry-run` | Process without persisting history |
| `--new` | Force a new session (ignore existing) |
| `-c, --context <name>` | Use a named context for gateway URL and credentials |

---

### `eval [name]`

Run agent evaluations. Eval files live in the agent directory and define test cases with expected outcomes.

```bash
npx @lobu/cli eval                           # run all evals
npx @lobu/cli eval basic-qa                  # run a specific eval
npx @lobu/cli eval --model claude/sonnet     # eval with a specific model
npx @lobu/cli eval --ci --output results.json  # CI mode with JSON output
```

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first in `lobu.toml`) |
| `-g, --gateway <url>` | Gateway URL (default: `http://localhost:8080`) |
| `-m, --model <model>` | Model to evaluate (e.g. `claude/sonnet`, `openai/gpt-4.1`) |
| `--trials <n>` | Override trial count |
| `--ci` | CI mode: JSON output, non-zero exit on failure |
| `--output <file>` | Write results to JSON file |
| `--list` | List available evals without running them |

---

### `run`

Run the agent stack. Validates `lobu.toml`, prepares environment variables, then starts `docker compose up`. Extra flags are forwarded to Docker Compose.

Without `-d`, the CLI starts containers then tails gateway logs. With `-d`, it starts detached and exits.

```bash
npx @lobu/cli run              # start and tail logs
npx @lobu/cli run -d           # detached mode
npx @lobu/cli run -d --build   # rebuild containers
```

---

### `validate`

Validate `lobu.toml` schema, skill IDs, and provider configuration.

```bash
npx @lobu/cli validate
```

Returns exit code `1` if validation fails.

---

### `context`

Manage named API contexts for switching between local and remote gateways.

```bash
npx @lobu/cli context list
npx @lobu/cli context current
npx @lobu/cli context add staging --api-url https://staging.example.com
npx @lobu/cli context use staging
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all configured contexts |
| `current` | Show the active context |
| `add <name> --api-url <url>` | Add a named context |
| `use <name>` | Set the active context |

Environment overrides: set `LOBU_CONTEXT` to select a context by name, or `LOBU_API_URL` to override the URL directly.

---

### `login`

Authenticate with Lobu Cloud. Opens a browser for OAuth by default.

```bash
npx @lobu/cli login
npx @lobu/cli login --token <api-token>      # CI/CD
npx @lobu/cli login --admin-password          # local dev fallback
npx @lobu/cli login -c staging               # login to a named context
npx @lobu/cli login --force                  # re-authenticate (revokes existing session)
```

| Flag | Description |
|------|-------------|
| `--token <token>` | Use an API token directly (for CI/CD pipelines) |
| `--admin-password` | Use the development-only admin password fallback |
| `-c, --context <name>` | Authenticate against a named context |
| `-f, --force` | Re-authenticate, revoking the existing session first |

---

### `logout`

Revoke the session server-side and clear stored credentials. If the gateway is unreachable, local credentials are still cleared.

```bash
npx @lobu/cli logout
npx @lobu/cli logout -c staging
```

| Flag | Description |
|------|-------------|
| `-c, --context <name>` | Clear credentials for a named context |

---

### `whoami`

Show the current authenticated user, linked agent, and API URL.

```bash
npx @lobu/cli whoami
npx @lobu/cli whoami -c staging
```

| Flag | Description |
|------|-------------|
| `-c, --context <name>` | Query a named context |

---

### `status`

Show agent health: lists agents with their providers and models, platform connections with status, and active sandboxes. Requires the gateway to be running.

```bash
npx @lobu/cli status
```

---

### `secrets`

Manage agent secrets (stored in `.env` for local dev).

```bash
npx @lobu/cli secrets set OPENAI_API_KEY sk-...
npx @lobu/cli secrets list
npx @lobu/cli secrets delete OPENAI_API_KEY
```

| Subcommand | Description |
|------------|-------------|
| `set <key> <value>` | Set a secret |
| `list` | List secrets (values redacted) |
| `delete <key>` | Remove a secret |

---

### `skills`

Browse and manage skills from the registry.

```bash
npx @lobu/cli skills list                # browse all skills
npx @lobu/cli skills search "calendar"   # search by name or description
npx @lobu/cli skills info google-workspace  # show details and required secrets
npx @lobu/cli skills add google-workspace   # add to lobu.toml
```

| Subcommand | Description |
|------------|-------------|
| `list` | Browse the skill registry |
| `search <query>` | Search skills by name or description |
| `info <id>` | Show skill details and required secrets |
| `add <id>` | Add a skill to `lobu.toml` |

---

### `providers`

Browse and manage LLM providers.

```bash
npx @lobu/cli providers list       # browse available providers
npx @lobu/cli providers add gemini  # add to lobu.toml
```

| Subcommand | Description |
|------------|-------------|
| `list` | Browse available LLM providers |
| `add <id>` | Add a provider to `lobu.toml` |

## Typical workflow

```bash
# 1. Scaffold
npx @lobu/cli init my-agent

# 2. Configure
cd my-agent
npx @lobu/cli skills add google-workspace
npx @lobu/cli providers add gemini
npx @lobu/cli secrets set GEMINI_API_KEY ...

# 3. Validate
npx @lobu/cli validate

# 4. Run locally
npx @lobu/cli run -d

# 5. Chat with your agent
npx @lobu/cli chat "Hello, what can you do?"
```
