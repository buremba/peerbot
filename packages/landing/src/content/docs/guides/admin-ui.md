---
title: Agent Management
description: Manage agents, providers, connections, and skills through the settings API and admin page.
---

Lobu exposes a settings API at `/api/v1/agents` for managing agents at runtime. Both the admin page and CLI commands use this API.

## Agent lifecycle

### Create an agent

Agents are created via `lobu.toml` (at startup) or the API (at runtime):

```bash
# Via API
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "support", "name": "Support Agent" }'
```

Returns the agent ID and a settings URL for configuration.

### List agents

```bash
curl http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

Returns all agents with their name, description, channel count, and last activity.

### Update an agent

```bash
curl -X PATCH http://localhost:8080/api/v1/agents/support \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Customer Support", "description": "Handles billing and account questions" }'
```

### Delete an agent

```bash
curl -X DELETE http://localhost:8080/api/v1/agents/support \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

Unbinds all platform channels and removes the agent configuration.

## Agent configuration

Fetch the full configuration for an agent:

```bash
curl http://localhost:8080/api/v1/agents/support/config \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

This returns everything about the agent:

| Section | What it contains |
|---------|-----------------|
| `providers` | Installed providers, connection status, model preferences, available catalog |
| `instructions` | Identity, soul, and user prompts (the IDENTITY.md / SOUL.md / USER.md content) |
| `skills` | Enabled skills with metadata, MCP server status |
| `mcpServers` | Custom MCP server configurations |
| `tools` | Nix packages, domain grants |
| `settings` | Verbose logging, memory enabled |

Each section includes `source` (`local`, `inherited`, or `mixed`) and `editable` flags so the UI knows what can be changed.

### Settings inheritance

When a user creates a new agent through a platform connection (e.g., a new Slack channel), it inherits settings from the **template agent** — the agent that owns the connection. This means:

- One configuration applies to all new users by default
- Individual agents can override specific sections
- Changes to the template propagate to agents that haven't overridden that section

## Provider management

### Add a provider via API key

```bash
curl -X POST http://localhost:8080/api/v1/auth/openai/save-key \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "support", "apiKey": "sk-..." }'
```

### Add a provider via device code (OAuth)

Some providers use device-code auth:

```bash
# Start the flow
curl -X POST http://localhost:8080/api/v1/auth/github/start \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "support" }'

# Poll for completion
curl -X POST http://localhost:8080/api/v1/auth/github/poll \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "support", "deviceAuthId": "..." }'
```

### Remove a provider

```bash
curl -X POST http://localhost:8080/api/v1/auth/openai/logout \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "support" }'
```

### Browse available providers

```bash
curl http://localhost:8080/api/v1/agents/support/config/providers/catalog \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

Returns providers that are not yet installed for this agent.

## Session history

Check agent status, view messages, and get session stats:

```bash
# Is the agent online?
curl http://localhost:8080/api/v1/agents/support/history/status \
  -H "Authorization: Bearer $ADMIN_PASSWORD"

# Get recent messages (paginated)
curl http://localhost:8080/api/v1/agents/support/history/session/messages \
  -H "Authorization: Bearer $ADMIN_PASSWORD"

# Session statistics (message counts, token usage)
curl http://localhost:8080/api/v1/agents/support/history/session/stats \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

## Channel bindings

View which platform channels are bound to an agent:

```bash
curl http://localhost:8080/api/v1/agents/support/channels \
  -H "Authorization: Bearer $ADMIN_PASSWORD"
```

## Interactive API reference

All endpoints are documented in the OpenAPI spec at `/api/docs` on your running gateway. Browse it for request/response schemas and try requests directly.
