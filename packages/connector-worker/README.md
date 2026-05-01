# @lobu/connector-worker

Self-hosted Lobu memory worker. Polls the backend for sync jobs, executes connectors locally, generates embeddings, and streams results back. Private workspace package — not published to npm.

## Usage

```bash
connector-worker daemon --api-url https://api.example.com
```

## Development

```bash
cd packages/connector-worker
API_URL=http://localhost:8787 bun run daemon
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `API_URL` | Backend API URL | Yes |
| `WORKER_ID` | Worker identifier (auto-generated if unset) | No |
| `WORKER_API_TOKEN` | Bearer token for backend auth | No |
| `WORKER_MAX_CONCURRENT_JOBS` | Max concurrent sync jobs | No |
| `EMBEDDINGS_MODEL` | Override local embedding model | No |
| `EMBEDDINGS_SERVICE_URL` | Use a remote embedding service instead of local | No |
| `GITHUB_TOKEN` | GitHub API token | No |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` | Reddit API credentials | No |
| `X_USERNAME` / `X_PASSWORD` / `X_EMAIL` / `X_2FA_SECRET` / `X_COOKIES` | X/Twitter credentials | No |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key | No |

## Embeddings

Generated locally via `@xenova/transformers` with `bge-base-en-v1.5` (768 dimensions). Runs on CPU, no external API calls. Set `EMBEDDINGS_SERVICE_URL` to offload to a remote service.

## License

BUSL-1.1. See the repository [LICENSE](../../LICENSE).
