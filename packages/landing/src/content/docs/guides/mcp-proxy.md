---
title: MCP Proxy
description: How the gateway proxies MCP requests for workers.
---

Workers never hold real credentials. The gateway resolves them at request time and proxies every outbound MCP call.

## Request flow

Every MCP URL a worker receives points back to the gateway with an `X-Mcp-Id` header identifying the upstream server.

1. Worker sends a JSON-RPC request to the gateway proxy.
2. Gateway authenticates the worker JWT, extracts `agentId` / `userId`.
3. Looks up credentials for that user via the device-auth flow — auto-refreshes expired tokens.
4. Injects the `Authorization` header, forwards to the upstream MCP.
5. Response flows back to the worker.

Workers call `tools/list` and `tools/call` — credential handling is invisible.

## Configuration sources

MCP servers come from two sources, merged per agent:

1. **Skills registry** (`config/system-skills.json`) — global MCPs available to every agent.
2. **Per-agent settings** — MCPs added through the settings page or agent-driven install.

Global MCPs take precedence when IDs collide.

## Authentication

MCP server authentication uses a device-code flow managed through Owletto:

1. Worker attempts to use an MCP tool that requires auth.
2. Gateway initiates a device-code flow and sends the user a login link.
3. User authenticates via the link, credentials are stored in Redis per `(agentId, userId, mcpId)`.
4. Future proxy requests inject the token automatically, with auto-refresh on expiry.

Third-party API integrations (GitHub, Google, etc.) are handled entirely by Owletto MCP servers — the gateway acts as a thin proxy.

## Configuration reference

### Adding an MCP to the skills registry

```json
{
  "id": "my-mcp",
  "name": "My MCP Server",
  "description": "What this MCP does",
  "mcpServers": [
    {
      "id": "my-mcp",
      "name": "My MCP",
      "url": "https://mcp.example.com",
      "type": "sse"
    }
  ]
}
```

With custom headers:

```json
{
  "id": "my-mcp",
  "name": "My MCP",
  "url": "https://mcp.example.com",
  "type": "sse",
  "headers": {
    "Authorization": "Bearer ${env:MY_MCP_TOKEN}"
  }
}
```

Header values support `${env:VAR_NAME}` substitution so secrets stay in environment variables.
