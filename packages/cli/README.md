# @lobu/cli

CLI tool for initializing and managing Lobu projects.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
docker compose up -d
```

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

- **Project name** and **deployment mode** (embedded/Docker workers)
- **Gateway port** and optional **public URL** (for OAuth callbacks)
- **Admin password**
- **Worker network access** (isolated, allowlist, or unrestricted)
- **AI provider** selection from the bundled provider registry + API key
- **Providers** to enable (from `config/providers.json`)
- **Messaging platform** (Telegram, Slack, Discord, or none)
- **Memory** selection (filesystem, Lobu Cloud, Owletto Local, or custom Owletto URL)

**Generates:** `docker-compose.yml`, `.env`, `Dockerfile.worker`, `lobu.toml`, `IDENTITY.md`, `.gitignore`, `README.md`

When Owletto-backed memory is enabled, `lobu init` also scaffolds the file-first memory layout:

- `[memory.owletto]` in `lobu.toml` (org, name, description, models, data)
- `models/`
- `data/`

For Owletto Local or a custom Owletto deployment, `.env` keeps `MEMORY_URL` as the optional base MCP URL override.

## Worker Customization

Extend the generated `Dockerfile.worker` to add system packages, Python packages, or custom scripts on top of `ghcr.io/lobu-ai/lobu-worker-base`. See [custom base image docs](../worker/docs/custom-base-image.md).

## License

Apache-2.0
