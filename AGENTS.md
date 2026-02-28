## Project Structure & Module Organization

### Package Architecture
- **`packages/core`**: Shared code between gateway and worker (interfaces, utils, types). Any code reused by both must live here.
- **`packages/gateway`**: Platform-agnostic gateway. Slack code under `src/slack/`. Orchestration under `src/orchestration/`. Future chat platforms (Discord, Teams) will live alongside as separate modules in dispatcher pattern.
- **`packages/worker`**: Agent execution via OpenClaw runtime in `src/openclaw/`. Worker talks only to gateway and agent. No Slack/platform knowledge.

### Module Boundaries
- Gateway: Slack → `src/slack/`, Telegram → `src/telegram/`, orchestration → `src/orchestration/`, future platforms → `src/dispatcher/{platform}/`
- Worker: Platform-agnostic, agent logic isolated to `src/openclaw/`
- Core: Shared interfaces, utils, types for gateway+worker

### Repository Layout
- Monorepo managed by Bun workspaces: `packages/gateway`, `packages/worker`, `packages/core`.
- Top-level: `Makefile`, `scripts/` (CLI/setup), `charts/lobu` (Helm), `config/` (biome, knip, etc.), `docker/` (Dockerfiles, compose), `docs/` (CHANGELOG, SECURITY, etc.), `.env*`.
- TypeScript sources under `packages/*/src`. Tests in `packages/*/src/__tests__` and `packages/core/tests`.
- **ALWAYS prefer `bun` commands over `npm`**
- When fixing unused parameter errors, remove the parameter entirely if possible rather than prefixing with underscore
- Worker prompt delivery: prompts are passed to the agent runtime directly (no named pipes used)

### Architecture

#### Platform
We currently use WhatsApp and Telegram as messaging platforms (Slack support also available but not configured).
Telegram code under `packages/gateway/src/telegram/`. Uses Grammy library with long-polling.
There is also a public endpoint in gateway to trigger running the agent.
Settings page provider order is drag-sortable via handle, with per-provider model selection inline in each provider row.

#### Orchestration
- **Deployment modes**: Kubernetes (production), Docker (development)
- All workers are sandboxed with your settings.
- **Workers must NEVER see real credentials.** Provider credentials are resolved by the gateway proxy using agentId from the URL path (`/api/proxy/{slug}/a/{agentId}/...`). Workers only receive opaque placeholders in env vars.

#### MCP
- Users pass the LOBU_MCP_SERVERS_URL env (pointing to `.lobu/mcp.config.json`) to enable MCP proxy in the gateway.
- Workers get MCP settings from gateway's internal config endpoint and use their JWT token to perform MCP calls through the proxy.
- Built-in MCPs available to workers: AskUser (request user input), UploadFile (share files with user).

#### Network

- Workers run on isolated internal network (`lobu-internal`) with no direct internet access. Gateway sits on both `lobu-public` and `lobu-internal` networks, acting as single egress point.
- **Proxy filtering**: Gateway runs custom Node.js HTTP proxy on port 8118. Workers configured with `HTTP_PROXY=http://gateway:8118` for all outbound requests (curl/wget/npm/git).
- **Network access control** (via `WORKER_ALLOWED_DOMAINS` environment variable):
  - **Complete isolation** (default): Leave empty or unset → workers have NO internet access
  - **Allowlist mode**: `WORKER_ALLOWED_DOMAINS="github.com"` → deny by default, allow only these domains
  - **Unrestricted access**: `WORKER_ALLOWED_DOMAINS="*"` → allow all domains (not recommended for production)
  - **Blocklist mode**: `WORKER_ALLOWED_DOMAINS="*"` + `WORKER_DISALLOWED_DOMAINS="malicious.com,spam.org"` → allow all except blocked
- **Domain format**: Exact domain (`api.example.com`) or wildcard (`.example.com` matches `*.example.com`)
- **Enforcement**: Docker's `internal: true` network flag prevents routing to external networks at infrastructure layer. Even if worker code is compromised, no network route exists. HTTP proxy provides selective access to approved domains only.

## TypeScript Build System

TypeScript packages must be compiled from `src/` → `dist/`. If you modify any package source code, run `make build-packages`. `make dev` (docker compose watch) automatically builds and syncs changes.

## Instructions
- You MUST only do what has been asked; nothing more, nothing less.
- When the user types a Slack message link (slack.com/archives/x/x/?thread_ts=) you MUST call ./scripts/slack-thread-viewer.js "link" to gather context
- When you are in planning mode and you're not fully sure, you need to ask 'codex exec "YOUR_QUESTION" --config model_reasoning_effort="high"'
- When you make changes to worker code (`packages/worker/*`), run `make clean-workers` to ensure new workers use the updated code.
- The "is running" thread status indicator (with rotating messages) provides user feedback during processing; visible "Still processing" heartbeat messages are not sent to avoid clutter.
- Anytime you make changes in the code, you MUST:

1. Have the stack running (`make dev`).
2. Test the bot using the test script:
```bash
./scripts/test-bot.sh "@me test prompt"
```
The script automatically handles sending the message, waiting for response, and checking logs. You can send multiple messages in sequence:
```bash
./scripts/test-bot.sh "@me first message" "follow up question" "another question"
```

- If you create ephemeral files, you MUST delete them when you're done with them.
- Use Docker to build and run the Slack bot in development mode, K8S for production.
- NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User. If you need to remember something, add it to CLAUDE.md as a a single sentence.
- ALWAYS ignore `/dist/` directories when analyzing code - these contain compiled artifacts, not source
- If you're referencing Slack threads or users in your response, add their direct links as well.

## File Upload Support

File attachments are fully supported in all message contexts (DM, app mentions, assistant threads). Gateway fetches complete message details via Slack API to ensure file metadata is captured, downloads files to worker's input directory, and the agent is instructed about file locations.

## Development Mode

### Prerequisites
- Bun: installed
- Docker Desktop: running

### First-time Setup
```bash
./scripts/setup-dev.sh
```

### Starting Development
```bash
make dev
```

This runs `docker compose watch` which starts the full stack (gateway, Redis, etc.) and auto-syncs source changes into containers. No manual rebuilds needed.

### Hot Reload
- **Gateway + Packages**: `docker compose watch` (`make dev`) auto-syncs source changes
- **Worker**: Run `make clean-workers` after worker code changes

### Testing
```bash
./scripts/test-bot.sh "@me test prompt"
```

### Check Logs
```bash
docker compose -f docker/docker-compose.yml logs -f gateway
```

### Deployment
1. **Development**: `make dev` (docker compose watch)
2. **Kubernetes deployment**: Use `make deploy` for production deployment

## Environment Configuration

The `.env` file is the single source of truth for all secrets and configuration.

### Local Development
- Gateway reads `.env` on startup via Docker Compose
- Restart after `.env` changes: `make dev` (or `docker compose -f docker/docker-compose.yml up`)
- Settings link token TTL defaults to 1 hour; optional dev override: `SETTINGS_TOKEN_TTL_MS` (milliseconds, e.g. `4233600000` for 7 weeks).

### Kubernetes Deployment
When `.env` changes, sync secrets to K8s using Sealed Secrets:

```bash
# Seal and apply secrets from .env
./scripts/seal-env.sh --apply

# Or output to file for review
./scripts/seal-env.sh -o sealed-secrets.yaml
kubectl apply -f sealed-secrets.yaml
```

**Prerequisites for Sealed Secrets:**
```bash
# Install controller (once per cluster)
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system

# Install CLI
brew install kubeseal
```

The gateway deployment has a checksum annotation that triggers automatic pod restart when secrets change via `helm upgrade`.

### Secrets Strategy Matrix

| Environment | Script | Approach | Git Safe |
|-------------|--------|----------|----------|
| **Production** | `./scripts/seal-env.sh --apply` | SealedSecrets | Yes - encrypted |
| **Staging** | `./scripts/seal-env.sh --apply` | SealedSecrets | Yes - encrypted |
| **Local K8s** | `./scripts/sync-env-to-k8s.sh` | Plain Secrets | No - dev only |
| **Docker** | N/A (reads .env directly) | File mount | N/A |

**Key Rules:**
- **Production**: Always use SealedSecrets. Never commit plain secrets to Git.
- **Local dev**: Use `sync-env-to-k8s.sh` for convenience (creates plain K8s secrets that disappear when cluster is deleted).
- **Never mix**: Choose one strategy per cluster and stick with it.

## Development Configuration

- Rate limiting is disabled in local development
- Worker image built with `make build-worker` or `make setup`
## Persistent Storage

Worker deployments use persistent volumes for session continuity across scale-to-zero:

1. **Per-Deployment PVC**: Each worker deployment gets its own PersistentVolumeClaim (1 thread = 1 PVC) mounted at `/workspace`
2. **Session Storage**: Agent sessions are stored in `/workspace/` (via `HOME=/workspace` environment variable)
3. **Auto-Resume**: When a worker scales back up, it automatically detects existing sessions and resumes
4. **Cleanup**: PVCs are automatically deleted when deployments are cleaned up after thread inactivity
5. **Docker Mode**: Uses host directory mounts at `./workspaces/{threadId}/` for equivalent persistence

## MCP OAuth Authentication

MCP (Model Context Protocol) servers can be authenticated via OAuth. Users authenticate through the Slack home tab.

### Configuration

1. **Set public gateway URL** (required for OAuth callbacks):
```bash
PUBLIC_GATEWAY_URL=https://your-domain.com
```

2. **Configure OAuth callback URL** in your OAuth provider:
```
${PUBLIC_GATEWAY_URL}/mcp/oauth/callback
```

3. **Configure MCP servers** with OAuth (two options):

**Option A: Full OAuth2 Configuration (Recommended)**
```json
{
  "mcpServers": {
    "github": {
      "url": "https://github-mcp.example.com",
      "oauth": {
        "authUrl": "https://github.com/login/oauth/authorize",
        "tokenUrl": "https://github.com/login/oauth/access_token",
        "clientId": "YOUR_GITHUB_CLIENT_ID",
        "clientSecret": "${env:GITHUB_CLIENT_SECRET}",
        "scopes": ["repo", "read:user"],
        "grantType": "authorization_code",
        "responseType": "code"
      }
    },
    "google": {
      "url": "https://google-mcp.example.com",
      "oauth": {
        "authUrl": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenUrl": "https://oauth2.googleapis.com/token",
        "clientId": "YOUR_GOOGLE_CLIENT_ID",
        "clientSecret": "${env:GOOGLE_CLIENT_SECRET}",
        "scopes": ["https://www.googleapis.com/auth/userinfo.profile"]
      }
    }
  }
}

**Option B: Simple Login URL (Basic)**
```json
{
  "mcpServers": {
    "custom": {
      "url": "https://custom-mcp.example.com",
      "loginUrl": "https://custom-mcp.example.com/oauth/authorize?client_id=YOUR_CLIENT_ID"
    }
  }
}
```

4. **Set client secrets in environment variables**:
```bash
export GITHUB_CLIENT_SECRET=your_github_client_secret
export GOOGLE_CLIENT_SECRET=your_google_client_secret
```

### User Authentication Flow

1. User opens Slack app home tab
2. Sees "Login" button for unauthenticated MCPs
3. Clicks "Login" → receives DM with OAuth link
4. Completes OAuth on MCP provider's site
5. Redirected back to callback → credentials stored
6. Home tab updates to show "Connected" with logout button

### Credential Storage

- Stored in Redis: `mcp:credential:{userId}:{mcpId}`
- Contains: accessToken, tokenType, expiresAt, refreshToken, metadata
- OAuth state stored temporarily (5 min TTL) for CSRF protection

## Testing Bot Deployments

Use the `test-bot.sh` script for easy bot testing. No manual curl commands needed.

**Platform self-testing behavior:**
- **Slack**: Cannot trigger its own event handlers (Slack filters bot-to-self messages). The test script uses `/api/messaging/send` endpoint which posts via bot token, then gateway receives as normal Slack events.
- **WhatsApp**: Supports self-chat mode! Set `WHATSAPP_SELF_CHAT=true` and send to the bot's own phone number. The gateway detects self-messages and queues them directly to workers, bypassing event handler filters.
- **Telegram**: `test-bot.sh` supports Telegram via `TEST_PLATFORM=telegram` and `TEST_CHANNEL=<chat_id|@username>` (or `TELEGRAM_TEST_CHAT_ID`) and sends through `tguser` as a real user account. Requires `TG_API_ID` and `TG_API_HASH` env vars (stored in `.env`). Bot receives via Grammy long-polling. In groups, @mention is always required; in DMs all messages are processed.

### Basic Test
```bash
./scripts/test-bot.sh "@me hello"
```

### Multi-Message Conversation Test
```bash
# Send multiple messages in sequence (automatically uses same thread)
./scripts/test-bot.sh "@me what is 5+5?" "now multiply that by 3" "thanks!"
```

### Custom Channel and Timeout
```bash
# Set environment variables
export TEST_PLATFORM="slack"   # or "whatsapp" or "telegram"
export TEST_CHANNEL="my-channel"
export TEST_TIMEOUT=60  # seconds to wait for response

./scripts/test-bot.sh "@me test with custom settings"
```

### File Upload Test
For file uploads, use the messaging API directly:
```bash
curl -X POST http://localhost:8080/api/messaging/send \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -F "platform=slack" \
  -F "channel=test-channel" \
  -F "message=@me analyze these files" \
  -F "files=@data.csv" \
  -F "files=@document.pdf"
```

### Telegram Test
Use `test-bot.sh`:
```bash
TEST_PLATFORM=telegram TEST_CHANNEL=@lobuaibot ./scripts/test-bot.sh "hello test"
```

Or use `tguser` CLI (requires `TG_API_ID` and `TG_API_HASH` from `.env`):
```bash
tguser send @lobuaibot "hello test"
```
