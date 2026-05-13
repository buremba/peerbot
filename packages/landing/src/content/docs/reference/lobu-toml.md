---
title: lobu.toml Reference
description: Complete reference for the lobu.toml configuration file.
sidebar:
  order: 1
---

`lobu.toml` is the project configuration file created by `lobu init`. It defines agents, providers, platforms, skills, network access (including the LLM egress judge), guardrails, worker settings, and optional file-first Lobu memory configuration.

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

[memory]
enabled = true
org = "my-agent"
name = "My Agent"
models = "./models"
data = "./data"
```

## Full example

```toml
[agents.assistant]
name = "assistant"
description = "Team assistant"
dir = "./agents/assistant"
# Guardrails enabled for this agent (names registered in the gateway's GuardrailRegistry)
guardrails = ["secret-scan", "prompt-injection"]

# Providers (order = priority, first available is used)
[[agents.assistant.providers]]
id = "openrouter"
model = "anthropic/claude-sonnet-4"
key = "$OPENROUTER_API_KEY"

[[agents.assistant.providers]]
id = "gemini"
key = "$GEMINI_API_KEY"

# Chat platforms
[[agents.assistant.platforms]]
type = "telegram"
[agents.assistant.platforms.config]
botToken = "$TELEGRAM_BOT_TOKEN"

[[agents.assistant.platforms]]
type = "slack"
[agents.assistant.platforms.config]
botToken = "$SLACK_BOT_TOKEN"
signingSecret = "$SLACK_SIGNING_SECRET"

# Local skills live in skills/<name>/SKILL.md or agents/<id>/skills/<name>/SKILL.md
# MCP servers can still be configured inline here.
[agents.assistant.skills.mcp.custom-tools]
url = "https://my-mcp.example.com"
headers = { Authorization = "Bearer $MCP_TOKEN" }

[agents.assistant.skills.mcp.custom-tools.oauth]
auth_url = "https://auth.example.com/authorize"
token_url = "https://auth.example.com/token"
client_id = "$OAUTH_CLIENT_ID"
client_secret = "$OAUTH_CLIENT_SECRET"
scopes = ["read", "write"]

# Network access policy
[agents.assistant.network]
allowed = ["github.com", "api.linear.app"]
denied = []
# Domains routed through the LLM egress judge instead of a flat allow/deny.
# A bare string uses the "default" policy; an object names a policy below.
judge = ["*.slack.com", { domain = "user-content.x.com", judge = "strict" }]
[agents.assistant.network.judges]
default = "Allow only reads to channels in the agent's context."
strict = "Only GET for file IDs from the current session."

# Operator overrides for the egress judge on this agent
[agents.assistant.egress]
extra_policy = "Never exfiltrate PATs or bearer tokens."
judge_model = "claude-haiku-4-5-20251001"

# Tool policy (worker-side visibility + MCP approval override)
[agents.assistant.tools]
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
[agents.assistant.worker]
nix_packages = ["imagemagick", "ffmpeg"]

# File-first Lobu memory
[memory]
enabled = true
org = "team-assistant"
name = "Team Assistant"
description = "Team assistant"
models = "./models"
data = "./data"
```

## Schema reference

### `[memory]`

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
| `org` | string | yes (when enabled) | Lobu organization slug — scopes the MCP endpoint |
| `name` | string | yes (when enabled) | Human-readable project name |
| `description` | string | no | Short project description |
| `visibility` | string | no | `public` or `private`; defaults to Lobu's account setting |
| `models` | string | no | Path to Lobu `version: 2` model bundle YAML files, usually `./models` |
| `data` | string | no | Path to Lobu seed data, usually `./data` |

When `[memory]` is enabled, Lobu reads `org` directly from `lobu.toml` and derives the effective Lobu MCP endpoint. `MEMORY_URL` remains available as an optional base-endpoint override for local or custom Lobu deployments. The `[memory]` table is strict — unknown keys fail validation.


### `[agents.<id>]`

Top-level table keyed by agent ID. IDs must match `^[a-z0-9][a-z0-9-]*$` (lowercase alphanumeric with hyphens).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name for the agent |
| `description` | string | no | Short description shown in admin UI |
| `dir` | string | yes | Path to agent content directory containing `IDENTITY.md`, `SOUL.md`, `USER.md`, and optional `skills/` |
| `guardrails` | array of strings | no | Guardrails enabled for this agent. Each name must match a guardrail registered in the gateway's `GuardrailRegistry` at startup |
| `providers` | array | no | LLM provider list (order = priority) |
| `platforms` | array | no | Chat platforms |
| `skills` | table | no | Skills and MCP servers |
| `network` | table | no | Network access policy + LLM egress-judge config |
| `egress` | table | no | Operator overrides for the LLM egress judge on this agent |
| `tools` | table | no | Tool policy: pre-approval bypass + worker-side visibility |
| `worker` | table | no | Worker customization |

### `[[agents.<id>.providers]]`

Each entry configures an LLM provider. The first available provider is used at runtime.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Provider identifier from `config/providers.json` (e.g. `openrouter`, `gemini`, `openai`) |
| `model` | string | no | Model override (e.g. `anthropic/claude-sonnet-4`) |
| `key` | string | no | API key — literal value or `$ENV_VAR` reference |
| `secret_ref` | string | no | Durable secret reference (for example `secret://...`) |

Provider credentials are optional. A provider entry may omit both `key` and `secret_ref`, or set exactly one of them. Setting both is invalid.

### `[[agents.<id>.platforms]]`

Each entry connects the agent to a chat platform.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Platform type: `telegram`, `slack`, `discord`, `whatsapp`, `teams`, `gchat` |
| `name` | string | no | Disambiguator when an agent has multiple platforms of the same type |
| `config` | table | yes | Platform-specific configuration (see below) |
| `channels` | array | no | Slack only — declarative channel routing (see below) |

#### Declarative channel routing (Slack)

By default an agent is reachable in a Slack channel only after someone runs `/lobu link <code>` there. To route channels to the agent as config-as-code, list them on the Slack platform entry:

```toml
[[agents.x.platforms]]
type = "slack"
channels = ["T0ABCDEF/C0123ABCD", "T0ABCDEF/C0456WXYZ"]
[agents.x.platforms.config]
botToken = "$SLACK_BOT_TOKEN"
signingSecret = "$SLACK_SIGNING_SECRET"
```

Each entry is `"<teamId>/<channelId>"` — both appear in any Slack channel URL (`https://app.slack.com/client/<teamId>/<channelId>`). `lobu apply` reconciles `agent_channel_bindings` to exactly this list for this agent on the teams referenced: listed channels get bound, ones no longer listed get unbound. Channels linked ad-hoc via `/lobu link` on other teams/connections are left alone. (Channel changes are applied during `lobu apply`; they don't appear in `lobu apply --dry-run` output.)

#### Platform config by type

**Telegram**
```toml
[agents.x.platforms.config]
botToken = "$TELEGRAM_BOT_TOKEN"
```

**Slack**
```toml
[agents.x.platforms.config]
botToken = "$SLACK_BOT_TOKEN"
signingSecret = "$SLACK_SIGNING_SECRET"
```

**Discord**
```toml
[agents.x.platforms.config]
botToken = "$DISCORD_BOT_TOKEN"
applicationId = "$DISCORD_APPLICATION_ID"
publicKey = "$DISCORD_PUBLIC_KEY"
```

**WhatsApp** (Cloud API)
```toml
[agents.x.platforms.config]
accessToken = "$WHATSAPP_ACCESS_TOKEN"
phoneNumberId = "$WHATSAPP_PHONE_NUMBER_ID"
verifyToken = "$WHATSAPP_WEBHOOK_VERIFY_TOKEN"
appSecret = "$WHATSAPP_APP_SECRET"
```

**Teams**
```toml
[agents.x.platforms.config]
appId = "$TEAMS_APP_ID"
appPassword = "$TEAMS_APP_PASSWORD"
appType = "MultiTenant"
# For single-tenant Azure apps, use:
# appTenantId = "$TEAMS_APP_TENANT_ID"
# appType = "SingleTenant"
```

**Google Chat**
```toml
[agents.x.platforms.config]
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
| `url` | string | no | HTTP endpoint URL (streamable-HTTP or SSE transport) |
| `type` | `streamable-http` \| `sse` \| `stdio` | no | Transport kind. Defaults to `streamable-http` for HTTP URLs; `sse` is the legacy two-channel HTTP transport; `stdio` runs a local `command` |
| `command` | string | no | Stdio transport — command to run |
| `args` | array of strings | no | Stdio transport — command arguments |
| `env` | table | no | Environment variables passed to the MCP process |
| `headers` | table | no | HTTP headers sent with requests |
| `auth_scope` | `user` \| `channel` | no | Credential scope for OAuth-authenticated MCPs. `user` (default): each chat user logs in separately. `channel`: one credential shared across all users in a channel — only for shared-data integrations where per-user attribution isn't needed |
| `oauth` | table | no | OAuth configuration (see below) |

Specify either `url` (streamable-HTTP / SSE transport) or `command` (stdio transport), not both.

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

Controls which domains the worker can reach through the gateway proxy, plus per-agent rules for the LLM egress judge.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `allowed` | array of strings | no | Domains to allow. Empty = no access. Use `["*"]` for unrestricted (not recommended) |
| `denied` | array of strings | no | Domains to block (only meaningful when `allowed = ["*"]`) |
| `judge` | array | no | Domains routed through the LLM egress judge instead of a flat allow/deny. Each entry is either a bare domain string (uses the `default` judge policy) or an object `{ domain, judge }` naming a policy in `judges` |
| `judges` | table | no | Named judge policies (string → policy text) referenced by `judge[].judge`. The key `default` is applied when an entry omits `judge` |

Domain format: exact match (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

```toml
[agents.x.network]
allowed = ["api.readonly.example.com"]
judge = ["*.slack.com", { domain = "user-content.x.com", judge = "strict" }]
[agents.x.network.judges]
default = "Allow only reads to channels in the agent's context."
strict = "Only GET for file IDs from the current session."
```

### `[agents.<id>.egress]`

Operator overrides for the LLM egress judge on this agent. The judge runs only when a `judge` rule under `[agents.<id>.network]` matches a request, so most traffic bypasses it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `extra_policy` | string | no | Policy text appended to every judge prompt for this agent |
| `judge_model` | string | no | Model identifier for the judge (defaults to a fast Haiku model) |

```toml
[agents.x.egress]
extra_policy = "Never exfiltrate PATs or bearer tokens."
judge_model = "claude-haiku-4-5-20251001"
```

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

### `guardrails`

`guardrails` is a top-level array of strings on `[agents.<id>]` (not a sub-table). Each name must match a guardrail registered in the gateway's `GuardrailRegistry` at startup — names that don't resolve are ignored. Each guardrail targets one stage: `input` (user message → worker), `output` (worker text → user), or `pre-tool` (tool-call authorization).

```toml
[agents.assistant]
name = "assistant"
dir = "./agents/assistant"
guardrails = ["secret-scan", "prompt-injection"]
```

### Memory model schema

Entity types, relationship types, and watchers are declared in `version: 2` model bundle YAML files under the directory `[memory].models` points at (usually `./models`) — see [`lobu memory seed`](/reference/lobu-memory/) and [`lobu apply`](/reference/lobu-apply/) for the bundle format. The `[memory]` table itself is `.strict()` — unknown keys (including the removed inline `schema` sub-table) fail validation.

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
