# @lobu/cli

CLI tool for initializing and managing Lobu projects.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
docker compose up -d
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

When Owletto memory is enabled, `lobu init` also scaffolds the file-first memory layout:

- `[memory.owletto]` in `lobu.toml` (org, name, description, models, data)
- `models/`
- `data/`

For Owletto Local or a custom Owletto deployment, `.env` keeps `MEMORY_URL` as the optional base MCP URL override.

## Usage

```bash
# Start services
docker compose up -d

# View logs
docker compose logs -f

# Stop services
docker compose down

# Rebuild worker after changes
docker compose build worker
```

## Worker Customization

Extend the generated `Dockerfile.worker` to add tools:

```dockerfile
FROM ghcr.io/lobu-ai/lobu-worker-base:0.1.0

# Add system packages
RUN apt-get update && apt-get install -y postgresql-client

# Add Python packages
RUN pip install pandas matplotlib

# Copy custom scripts
COPY ./scripts /workspace/scripts
```

See [custom base image docs](../worker/docs/custom-base-image.md) for using your own base image.

## License

Apache-2.0
