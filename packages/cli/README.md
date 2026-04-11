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
- **AI provider** selection from the skills registry + API key
- **Skills** to enable (from `config/system-skills.json`)
- **Messaging platform** (Telegram, Slack, Discord, or none)
- **Auth provider** (Owletto, custom, or none)
- **Memory plugin** configuration

**Generates:** `docker-compose.yml`, `.env`, `Dockerfile.worker`, `lobu.toml`, `IDENTITY.md`, `.gitignore`, `README.md`

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
