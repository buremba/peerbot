# @owletto/worker

Self-hosted worker for Owletto. Includes connectors, feeds, and local embedding generation.

## Installation

```bash
npm install -g @owletto/worker
```

## Usage

```bash
owletto-worker daemon --api-url https://api.example.com
```

The daemon polls for sync jobs, executes them locally, generates embeddings, and streams results back.

## Development

```bash
cd packages/worker
API_URL=http://localhost:8787 pnpm daemon

# Or directly:
npx tsx src/bin.ts daemon --api-url http://localhost:8787
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `API_URL` | Backend API URL | Yes |
| `WORKER_ID` | Worker identifier (auto-generated if unset) | No |
| `GITHUB_TOKEN` | GitHub API token | No |
| `REDDIT_CLIENT_ID` | Reddit API client ID | No |
| `REDDIT_CLIENT_SECRET` | Reddit API client secret | No |
| `REDDIT_USER_AGENT` | Reddit API user agent | No |
| `X_USERNAME` | X/Twitter username | No |
| `X_PASSWORD` | X/Twitter password | No |
| `X_EMAIL` | X/Twitter email | No |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key | No |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│            @owletto/worker                                   │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │ Worker Daemon│  │ Feeds        │                         │
│  │ (poll loop)  │  │ + Embeddings │                         │
│  └──────┬───────┘  └──────────────┘                         │
└─────────┼───────────────────────────────────────────────────┘
          │  HTTP/REST
          ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ MCP + REST   │  │ Tools        │  │ Database     │      │
│  │ Endpoints    │  │              │  │ (Postgres)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## API Endpoints

- `POST /api/workers/poll` — Poll for available jobs
- `POST /api/workers/heartbeat` — Heartbeat during execution
- `POST /api/workers/stream` — Stream synced content
- `POST /api/workers/complete` — Report job completion

## Embeddings

Generated locally via `@xenova/transformers` with `bge-base-en-v1.5` (768 dimensions). Runs on CPU, no external API calls.

## License

BSL 1.1. See the repository [LICENSE](../../LICENSE).
