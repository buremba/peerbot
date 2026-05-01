# @lobu/cli

CLI tool for running Lobu locally and managing Lobu agents through the same REST API as the web app.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
# edit .env to set DATABASE_URL
npx @lobu/cli@latest run
```

Lobu boots as a single Node process. Postgres is a user-provided external (managed instance or local — `brew services start postgresql`).

## Commands

### `lobu init [name]`

Scaffold a new Lobu project with interactive prompts:

- **Project name**
- **Gateway port** and optional **public URL** (for OAuth callbacks)
- **Worker network access** (isolated, allowlist, or unrestricted)
- **AI provider** selection from the bundled provider registry + API key
- **Messaging platform** (Telegram, Slack, Discord, WhatsApp, Teams, Google Chat, or none)
- **Memory** selection (filesystem, Lobu Cloud, or custom Owletto URL)

**Generates:** `lobu.toml`, `.env` (with `DATABASE_URL` placeholder), `agents/<name>/` (`IDENTITY.md`, `SOUL.md`, `USER.md`, `skills/`, `evals/`), `skills/`, `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`.

When Owletto-backed memory is enabled, `lobu init` also scaffolds the file-first memory layout:

- `[memory.owletto]` in `lobu.toml` (org, name, description, models, data)
- `models/`
- `data/`

For a custom Owletto deployment, `.env` keeps `MEMORY_URL` as the optional base MCP URL override.

### `lobu run`

Boot the embedded Lobu stack — gateway + workers + embeddings + Owletto memory backend in a single Node process. `lobu.toml` is not required; set `DATABASE_URL` in the environment or `.env`, then the command spawns the bundled `@lobu/server/dist/server.bundle.mjs`. Ctrl+C stops the process and any spawned worker subprocesses cleanly.

## License

Apache-2.0
