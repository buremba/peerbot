# @lobu/cli

CLI tool for initializing and managing Lobu projects.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
# edit .env to set DATABASE_URL and REDIS_URL
npx @lobu/cli@latest run
```

Lobu boots as a single Node process. Postgres + Redis are user-provided externals (managed instances or local — `brew services start postgresql redis`).

## Starter Skills

Install the Lobu starter skill into a local `skills/` directory:

```bash
npx @lobu/cli@latest skills list
npx @lobu/cli@latest skills add lobu
```

Install the Owletto starter skill separately with the Owletto CLI:

```bash
npx owletto@latest skills add owletto
npx owletto@latest init
```

## Commands

### `lobu init [name]`

Scaffold a new Lobu project with interactive prompts:

- **Project name**
- **Gateway port** and optional **public URL** (for OAuth callbacks)
- **Admin password**
- **Worker network access** (isolated, allowlist, or unrestricted)
- **AI provider** selection from the bundled provider registry + API key
- **Messaging platform** (Telegram, Slack, Discord, WhatsApp, Teams, Google Chat, or none)
- **Memory** selection (filesystem, Lobu Cloud, or custom Owletto URL)

**Generates:** `lobu.toml`, `.env` (with `DATABASE_URL` / `REDIS_URL` placeholders), `agents/<name>/` (`IDENTITY.md`, `SOUL.md`, `USER.md`, `skills/`, `evals/`), `skills/`, `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`.

When Owletto-backed memory is enabled, `lobu init` also scaffolds the file-first memory layout:

- `[memory.owletto]` in `lobu.toml` (org, name, description, models, data)
- `models/`
- `data/`

For a custom Owletto deployment, `.env` keeps `MEMORY_URL` as the optional base MCP URL override.

### `lobu run`

Boot the embedded Lobu stack — gateway + workers + embeddings + Owletto memory backend in a single Node process. Validates `lobu.toml` and that `DATABASE_URL` and `REDIS_URL` are set in `.env`, then spawns the bundled `@lobu/owletto-backend/dist/server.bundle.mjs`. Ctrl+C stops the process and any spawned worker subprocesses cleanly.

## License

Apache-2.0
