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

### `lobu init [name]`

Scaffold a new agent project with `lobu.toml`, Docker Compose, and environment config.

```bash
npx @lobu/cli init my-agent
```

Generates:

- `lobu.toml` — agent configuration (skills, providers, identity)
- `docker-compose.yml` — service definitions (gateway, Redis, worker)
- `.env` — credentials and environment variables
- `Dockerfile.worker` — worker image customization
- `IDENTITY.md` — agent identity prompt
- `.gitignore`, `README.md`

Options:

| Flag | Description |
|------|-------------|
| `-t, --template <name>` | Starter template (`support`, `coding`, `general`) |

---

### `lobu run`

Run the agent stack. Reads `lobu.toml`, then starts Docker Compose. All extra flags are forwarded to `docker compose up`.

```bash
lobu run -d          # detached mode
lobu run -d --build  # rebuild containers
```

---

### `lobu validate`

Validate `lobu.toml` schema, skill IDs, and provider configuration.

```bash
lobu validate
```

Returns exit code `1` if validation fails.

---

### `lobu login`

Authenticate with a remote Lobu gateway. Opens a browser for OAuth by default.

```bash
lobu login
lobu login --token <api-token>   # CI/CD
```

Options:

| Flag | Description |
|------|-------------|
| `--token <token>` | Use an API token directly (for CI/CD pipelines) |

---

### `lobu logout`

Clear stored credentials.

```bash
lobu logout
```

---

### `lobu whoami`

Show the current authenticated user and linked agent.

```bash
lobu whoami
```

---

### `lobu status`

Show agent health and version info.

```bash
lobu status
```

---

### `lobu secrets`

Manage agent secrets (stored in `.env` for local dev).

```bash
lobu secrets set OPENAI_API_KEY sk-...
lobu secrets list
lobu secrets delete OPENAI_API_KEY
```

| Subcommand | Description |
|------------|-------------|
| `set <key> <value>` | Set a secret |
| `list` | List secrets (values redacted) |
| `delete <key>` | Remove a secret |

---

### `lobu skills`

Browse and manage skills from the registry.

```bash
lobu skills list                # browse all skills
lobu skills search "calendar"   # search by name or description
lobu skills info google-workspace  # show details and required secrets
lobu skills add google-workspace   # add to lobu.toml
```

| Subcommand | Description |
|------------|-------------|
| `list` | Browse the skill registry |
| `search <query>` | Search skills by name or description |
| `info <id>` | Show skill details and required secrets |
| `add <id>` | Add a skill to `lobu.toml` |

---

### `lobu providers`

Browse and manage LLM providers.

```bash
lobu providers list       # browse available providers
lobu providers add gemini  # add to lobu.toml
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
lobu skills add google-workspace
lobu providers add gemini
lobu secrets set GEMINI_API_KEY ...

# 3. Validate
lobu validate

# 4. Run locally
lobu run -d
```
