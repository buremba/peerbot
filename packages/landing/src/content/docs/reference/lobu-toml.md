---
title: lobu.toml Reference
description: Complete reference for the lobu.toml configuration file.
sidebar:
  order: 1
---

`lobu.toml` is the project configuration file created by `lobu init`. It defines agents, providers, connections, skills, network access, worker settings, and optional file-first Lobu memory configuration.

## Minimal example

```toml
[agents.my-agent]
name = "my-agent"
dir = "./agents/my-agent"

[[agents.my-agent.providers]]
id = "openrouter"
key = "$OPENROUTER_API_KEY"

[agents.my-agent.network]
allowed = ["github.com"]

[memory.owletto]
enabled = true
org = "my-agent"
name = "My Agent"
models = "./models"
data = "./data"
```

## Full example

```toml
[agents.support]
name = "support"
description = "Customer support agent"
dir = "./agents/support"

# Providers (order = priority, first available is used)
[[agents.support.providers]]
id = "openrouter"
model = "anthropic/claude-sonnet-4"
key = "$OPENROUTER_API_KEY"

[[agents.support.providers]]
id = "gemini"
key = "$GEMINI_API_KEY"

# Platform connections
[[agents.support.connections]]
type = "telegram"
[agents.support.connections.config]
botToken = "$TELEGRAM_BOT_TOKEN"

[[agents.support.connections]]
type = "slack"
[agents.support.connections.config]
botToken = "$SLACK_BOT_TOKEN"
signingSecret = "$SLACK_SIGNING_SECRET"

# Local skills live in skills/<name>/SKILL.md or agents/<id>/skills/<name>/SKILL.md
# MCP servers can still be configured inline here.
[agents.support.skills.mcp.custom-tools]
url = "https://my-mcp.example.com"
headers = { Authorization = "Bearer $MCP_TOKEN" }

[agents.support.skills.mcp.custom-tools.oauth]
auth_url = "https://auth.example.com/authorize"
token_url = "https://auth.example.com/token"
client_id = "$OAUTH_CLIENT_ID"
client_secret = "$OAUTH_CLIENT_SECRET"
scopes = ["read", "write"]

# Network access policy
[agents.support.network]
allowed = ["github.com", "api.linear.app"]
denied = []

# Tool policy (worker-side visibility + MCP approval override)
[agents.support.tools]
# Bypass the in-thread approval card for these destructive MCP tools.
pre_approved = [
  "/mcp/gmail/tools/list_messages",
  "/mcp/linear/tools/*",
]
# Worker-side tool visibility (optional).
allowed = ["Read", "Grep", "mcp__gmail__*"]
denied = ["Bash(rm:*)"]
strict = false

# Worker customization
[agents.support.worker]
nix_packages = ["imagemagick", "ffmpeg"]

# File-first Lobu memory
[memory.owletto]
enabled = true
org = "support"
name = "Support"
description = "Customer support agent"
models = "./models"
data = "./data"
```

## Schema reference

### `[memory.owletto]`

Optional project-level Lobu memory configuration for file-first projects.

Typical companion layout:

```text
project/
├── lobu.toml
├── models/
└── data/
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | no | Enables file-first Lobu memory resolution for the project |
| `org` | string | yes (when enabled) | Lobu memory organization slug — scopes the MCP endpoint |
| `name` | string | yes (when enabled) | Human-readable project name |
| `description` | string | no | Short project description |
| `visibility` | string | no | `public` or `private`; defaults to Lobu's account setting |
| `models` | string | no | Path to Lobu memory model files, usually `./models` |
| `data` | string | no | Path to Lobu memory seed data, usually `./data` |

When `[memory.owletto]` is enabled, Lobu reads `org` directly from `lobu.toml` and derives the effective Lobu memory MCP endpoint. `MEMORY_URL` remains available as an optional base-endpoint override for local or custom Lobu memory deployments.


### `[agents.<id>]`

Top-level table keyed by agent ID. IDs must match `^[a-z0-9][a-z0-9-]*$` (lowercase alphanumeric with hyphens).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name for the agent |
| `description` | string | no | Short description shown in admin UI |
| `dir` | string | yes | Path to agent content directory containing `IDENTITY.md`, `SOUL.md`, `USER.md`, and optional `skills/` |
| `providers` | array | no | LLM provider list (order = priority) |
| `connections` | array | no | Platform connections |
| `skills` | table | no | Skills and MCP servers |
| `network` | table | no | Network access policy |
| `tools` | table | no | Tool policy: pre-approval bypass + worker-side visibility |
| `worker` | table | no | Worker customization |

### `[[agents.<id>.providers]]`

Each entry configures an LLM provider. The first available provider is used at runtime.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Provider identifier (e.g. `openrouter`, `anthropic`, `gemini`, `openai`) |
| `model` | string | no | Model override (e.g. `anthropic/claude-sonnet-4`) |
| `key` | string | no | API key — literal value or `$ENV_VAR` reference |
| `secret_ref` | string | no | Durable secret reference (for example `secret://...`) |

Provider credentials are optional. A provider entry may omit both `key` and `secret_ref`, or set exactly one of them. Setting both is invalid.

### `[[agents.<id>.connections]]`

Each entry connects the agent to a messaging platform.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Platform type: `telegram`, `slack`, `discord`, `whatsapp`, `teams`, `gchat` |
| `config` | table | yes | Platform-specific configuration (see below) |

#### Connection config by platform

**Telegram**
```toml
[agents.x.connections.config]
botToken = "$TELEGRAM_BOT_TOKEN"
```

**Slack**
```toml
[agents.x.connections.config]
botToken = "$SLACK_BOT_TOKEN"
signingSecret = "$SLACK_SIGNING_SECRET"
```

**Discord**
```toml
[agents.x.connections.config]
botToken = "$DISCORD_BOT_TOKEN"
applicationId = "$DISCORD_APPLICATION_ID"
publicKey = "$DISCORD_PUBLIC_KEY"
```

**WhatsApp** (Cloud API)
```toml
[agents.x.connections.config]
accessToken = "$WHATSAPP_ACCESS_TOKEN"
phoneNumberId = "$WHATSAPP_PHONE_NUMBER_ID"
verifyToken = "$WHATSAPP_WEBHOOK_VERIFY_TOKEN"
appSecret = "$WHATSAPP_APP_SECRET"
```

**Teams**
```toml
[agents.x.connections.config]
appId = "$TEAMS_APP_ID"
appPassword = "$TEAMS_APP_PASSWORD"
appTenantId = "$TEAMS_APP_TENANT_ID"
appType = "MultiTenant"
```

**Google Chat**
```toml
[agents.x.connections.config]
credentials = "$GOOGLE_CHAT_CREDENTIALS"
```

### `[agents.<id>.skills]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mcp` | table | no | Custom MCP server definitions |

### `[agents.<id>.skills.mcp.<name>]`

Each entry defines a custom MCP server.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | no | SSE/Streamable HTTP endpoint URL |
| `command` | string | no | Stdio transport — command to run |
| `args` | array of strings | no | Stdio transport — command arguments |
| `env` | table | no | Environment variables passed to the MCP process |
| `headers` | table | no | HTTP headers sent with requests |
| `oauth` | table | no | OAuth configuration (see below) |

Specify either `url` (SSE/HTTP transport) or `command` (stdio transport), not both.

### `[agents.<id>.skills.mcp.<name>.oauth]`

OAuth configuration for MCP servers that require authenticated access.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `auth_url` | string | yes | Authorization endpoint |
| `token_url` | string | yes | Token endpoint |
| `client_id` | string | no | OAuth client ID (literal or `$ENV_VAR`) |
| `client_secret` | string | no | OAuth client secret (literal or `$ENV_VAR`) |
| `scopes` | array of strings | no | Requested scopes |
| `token_endpoint_auth_method` | string | no | Auth method: `none`, `client_secret_post`, `client_secret_basic` |

### `[agents.<id>.network]`

Controls which domains the worker can reach through the gateway proxy.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `allowed` | array of strings | no | Domains to allow. Empty = no access. Use `["*"]` for unrestricted (not recommended) |
| `denied` | array of strings | no | Domains to block (only meaningful when `allowed = ["*"]`) |

Domain format: exact match (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

### `[agents.<id>.tools]`

Operator-level tool policy. Two independent concerns:

See [Tool Policy](/guides/tool-policy/) for behavior and examples; this section is the exact schema reference.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pre_approved` | array of strings | no | MCP tool grant patterns that bypass the in-thread approval card. Each entry must match `/mcp/<mcp-id>/tools/<tool-name>` or `/mcp/<mcp-id>/tools/*` — malformed entries fail schema validation. Synced to the grant store at deployment time. |
| `allowed` | array of strings | no | Tools the worker can call. Patterns follow Claude Code's permission format: `Read`, `Bash(git:*)`, `mcp__github__*`, `*`. |
| `denied` | array of strings | no | Tools to always block. Takes precedence over `allowed`. |
| `strict` | boolean | no | If `true`, ONLY `allowed` tools are permitted (defaults are ignored). Default `false`. |

**`pre_approved` is an operator-only escape hatch.** Destructive MCP tools normally require user approval in-thread (per MCP `destructiveHint` annotations). Skills cannot set this field — bypassing approval is strictly the operator's call, visible in the `lobu.toml` diff.

### `[agents.<id>.worker]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nix_packages` | array of strings | no | Nix packages to install in the worker environment |

## Environment variable references

Any string value can reference an environment variable with `$ENV_VAR` syntax. The CLI resolves these from `.env` at runtime.

```toml
key = "$OPENROUTER_API_KEY"     # resolved from .env
key = "sk-literal-value"        # used as-is
```

## Validation

```bash
npx @lobu/cli@latest validate
```

Checks TOML syntax, schema conformance, skill IDs, and provider configuration. Returns exit code 1 on failure.
