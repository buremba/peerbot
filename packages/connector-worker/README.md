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

## Route a device Automation into Claude Code

Start one standalone daemon independently (for example from launchd or a terminal):

```bash
lobu daemon
```

Then, from the already-running interactive Claude Code session that should receive a specific Automation:

```bash
lobu automation attach <automation-id>
lobu automation attachments
```

The attachment is an exact local `automation_id -> Claude session_id` route. It does not change the Automation remotely: the Automation must already be pinned to this daemon's Lobu device. Use `lobu automation detach <automation-id>` to remove the route. If an attached session is offline, the run fails instead of spawning a fresh Claude process.

Claude's local socket protocol has no delivery acknowledgement or cancellation. Lobu treats a successful authenticated socket write as handoff and waits for the session's private run helper to signal completion. A timed-out attempt reports through the normal Automation lifecycle, but it cannot stop the parent interactive Claude turn, so each attempt receives a unique completion command and result file: a late `finish` from a superseded turn can never be returned as a later attempt's answer. Run-scoped Lobu access is revoked when the run ends, not when an individual attempt times out.

Because the target is a Claude session the user already started, Lobu cannot sanitize its environment the way it does for a spawned CLI; only the helper's own subprocess environment is scrubbed of `WORKER_API_TOKEN`.

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
| `GOOGLE_MAPS_API_KEY` | Google Maps API key | No |

## Embeddings

Generated locally via `@xenova/transformers` with `bge-base-en-v1.5` (768 dimensions). Runs on CPU, no external API calls. Set `EMBEDDINGS_SERVICE_URL` to offload to a remote service.

## License

BUSL-1.1. See the repository [LICENSE](../../LICENSE).
