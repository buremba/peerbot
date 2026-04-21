---
title: MCP Proxy
description: How the gateway proxies MCP requests and handles per-user authentication for workers.
---

Workers never hold real credentials. The gateway resolves them at request time and proxies every outbound MCP call.

## Request flow

Every MCP URL a worker receives points back to the gateway with an `X-Mcp-Id` header identifying the upstream server.

1. Worker sends a JSON-RPC request to the gateway proxy.
2. Gateway authenticates the worker JWT, extracts `agentId` / `userId`.
3. Looks up credentials for that user — auto-refreshes expired tokens.
4. Injects the `Authorization: Bearer <token>` header, forwards to the upstream MCP.
5. Response flows back to the worker.

Workers call `tools/list` and `tools/call` — credential handling is invisible.

## Configuration sources

MCP servers come from two sources, merged per agent:

1. **Agent settings + local skills** — MCP servers come from per-agent settings and local `SKILL.md` files.
2. **Per-agent settings** — MCPs added through the settings page or agent-driven install.

Global MCPs take precedence when IDs collide.

## Authentication methods

There are three ways an MCP server can authenticate:

| Method | Config field | Use case |
|--------|-------------|----------|
| **Static headers** | `headers` | API keys, service tokens — no per-user auth needed |
| **Device-code OAuth** | `oauth` on the MCP server | Per-user OAuth — each user authenticates in their browser |
| **Owletto-managed** | N/A (Owletto handles internally) | Third-party APIs (GitHub, Google, Linear, etc.) |

### Static headers

For MCP servers that use a shared API key or service token. The header value supports `${env:VAR_NAME}` substitution so secrets stay in environment variables.

```json
{
  "id": "my-mcp",
  "mcpServers": [{
    "id": "my-mcp",
    "url": "https://mcp.example.com",
    "type": "sse",
    "headers": {
      "Authorization": "Bearer ${env:MY_MCP_TOKEN}"
    }
  }]
}
```

No user interaction needed. The gateway injects the header on every request.

### Device-code OAuth (per-user auth)

For MCP servers that implement the [OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628). Each user authenticates individually by clicking a link and logging in via their browser.

#### How it works

```
User (chat)          Worker              Gateway              MCP Server (OAuth)
    |                   |                   |                       |
    |  "use tool X"     |                   |                       |
    |------------------>|                   |                       |
    |                   |  tools/call X     |                       |
    |                   |------------------>|                       |
    |                   |                   |  tools/call X         |
    |                   |                   |---------------------->|
    |                   |                   |  401 Unauthorized     |
    |                   |                   |<---------------------|
    |                   |                   |                       |
    |                   |                   |  POST /oauth/register |
    |                   |                   |---------------------->|
    |                   |                   |  { client_id }        |
    |                   |                   |<---------------------|
    |                   |                   |                       |
    |                   |                   |  POST /oauth/device_authorization
    |                   |                   |---------------------->|
    |                   |                   |  { device_code,       |
    |                   |                   |    user_code,         |
    |                   |                   |    verification_uri } |
    |                   |                   |<---------------------|
    |                   |                   |                       |
    |                   |  login_required   |                       |
    |                   |  + link + code    |                       |
    |                   |<------------------|                       |
    |  "Click this link |                   |                       |
    |   and enter code  |                   |                       |
    |   ABCD-1234"      |                   |                       |
    |<------------------|                   |                       |
    |                   |                   |                       |
    |  (user clicks link, logs in via browser)                     |
    |                   |                   |                       |
    |  "done, try again"|                   |                       |
    |------------------>|                   |                       |
    |                   |  tools/call X     |                       |
    |                   |------------------>|                       |
    |                   |                   |  poll device_code     |
    |                   |                   |---------------------->|
    |                   |                   |  { access_token,      |
    |                   |                   |    refresh_token }    |
    |                   |                   |<---------------------|
    |                   |                   |                       |
    |                   |                   |  (store in Redis)     |
    |                   |                   |                       |
    |                   |                   |  tools/call X + token |
    |                   |                   |---------------------->|
    |                   |                   |  { result }           |
    |                   |                   |<---------------------|
    |                   |  { result }       |                       |
    |                   |<------------------|                       |
    |  "Here's the      |                   |                       |
    |   result..."      |                   |                       |
    |<------------------|                   |                       |
```

#### Step by step

1. **Tool call fails with auth error** — Worker calls a tool, gateway proxies it, upstream MCP returns 401/403.

2. **Gateway auto-starts device-code flow** — Detects the auth error and:
   - Registers as an OAuth client at `{mcp-server-origin}/oauth/register` (cached per MCP server)
   - Requests a device code from `{mcp-server-origin}/oauth/device_authorization`
   - Gets back a `user_code`, `verification_uri`, and `device_code`

3. **User gets a link in chat** — The gateway returns a `login_required` response to the worker, which shows the user:
   > Authentication required. Visit `https://mcp.example.com/oauth/device` and enter code `ABCD-1234`

4. **User authenticates in browser** — Clicks the link, enters the code, and authorizes the application.

5. **Gateway polls for completion** — On the next tool call from the worker, the gateway polls the token endpoint with the `device_code`. If the user has completed auth, it receives `access_token` + `refresh_token`.

6. **Credentials stored** — Encrypted in Redis, keyed by `(agentId, userId, mcpId)`, with 90-day TTL.

7. **Future calls are transparent** — Gateway injects `Authorization: Bearer <token>` on every proxied request. No more user interaction needed.

#### Token lifecycle

- **Storage**: Encrypted at rest in Redis with 90-day TTL
- **Auto-refresh**: When a token is within 5 minutes of expiry, the gateway refreshes it using the `refresh_token` before proxying the request
- **Refresh locking**: A Redis lock prevents concurrent refresh races across gateway instances
- **Expiry fallback**: If refresh fails (no refresh token, revoked, etc.), the next tool call triggers a new device-code flow

#### Configuration

By default, the gateway auto-derives OAuth endpoints from the MCP server's URL origin:

- Registration: `{origin}/oauth/register`
- Device authorization: `{origin}/oauth/device_authorization`
- Token: `{origin}/oauth/token`
- Verification (for user): `{origin}/oauth/device`

If the MCP server's OAuth endpoints live at non-standard paths, or if you have a pre-registered client, you can override any of these via the `oauth` config. All fields are optional — omitted fields fall back to auto-derivation:

```json
{
  "oauth": {
    "clientId": "my-pre-registered-client",
    "clientSecret": "secret",
    "tokenUrl": "https://auth.example.com/oauth/token",
    "deviceAuthorizationUrl": "https://auth.example.com/oauth/device_authorization",
    "registrationUrl": "https://auth.example.com/oauth/register",
    "authUrl": "https://auth.example.com/oauth/device",
    "scopes": ["read", "write"],
    "resource": "https://api.example.com"
  }
}
```

When `clientId` is provided, dynamic client registration is skipped entirely — useful when you've pre-registered an OAuth application with the MCP server.

### Lobu-memory-managed auth

Third-party API integrations (GitHub, Google, Linear, Notion, etc.) are handled by Owletto MCP servers. Owletto manages OAuth flows, token storage, and API proxying internally. The gateway acts as a thin proxy — it doesn't know or care about the integration's auth.

Workers access these APIs through Owletto tools (e.g., `owletto_github_read_repo`). If Owletto needs the user to authenticate, it returns instructions for the user to call `owletto_login`.

## Worker auth awareness

Workers receive MCP status at session startup that includes auth state:

```typescript
interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;     // MCP config has oauth
  requiresInput: boolean;    // MCP needs manual config inputs
  authenticated: boolean;    // User has valid stored credential
  configured: boolean;       // Manual inputs have been provided
}
```

Based on this status, the worker's system prompt includes setup instructions for any MCPs that need authentication. This lets the agent proactively guide users through login rather than waiting for a tool call to fail.

## SSRF protection

The proxy resolves upstream URLs and blocks requests to reserved/internal IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local, IPv6 loopback/ULA). This prevents workers from using MCP configs to reach internal services.

## Session management

MCP sessions (via `Mcp-Session-Id` header) are tracked in Redis with 30-minute TTL. If an upstream returns "Server not initialized" (stale session), the gateway automatically re-initializes with the MCP handshake (`initialize` + `notifications/initialized`) before retrying.

## Tool approval

MCP tools can declare [annotations](https://modelcontextprotocol.io/docs/concepts/tool-annotations) indicating whether they are destructive or have side effects. The gateway checks these annotations and may require explicit user approval before executing a tool call. Grants are stored per agent and checked on each call.

## Configuration reference

### Adding an MCP via local skills or agent settings

Skills-registry entries wrap one or more MCP server definitions:

```json
{
  "id": "my-mcp",
  "name": "My MCP Server",
  "description": "What this MCP does",
  "mcpServers": [ /* one of the server configs below */ ]
}
```

The inner `mcpServers[]` entry varies by auth mode:

**No auth**
```json
{ "id": "my-mcp", "name": "My MCP", "url": "https://mcp.example.com", "type": "sse" }
```

**Static auth headers** (`${env:VAR}` substitution)
```json
{
  "id": "my-mcp", "name": "My MCP", "url": "https://mcp.example.com", "type": "sse",
  "headers": { "Authorization": "Bearer ${env:MY_MCP_TOKEN}" }
}
```

**Per-user OAuth, auto-derived endpoints**
```json
{
  "id": "my-mcp", "name": "My MCP", "url": "https://mcp.example.com", "type": "sse",
  "oauth": {}
}
```

**Per-user OAuth, pre-registered client or custom endpoints**
```json
{
  "id": "my-mcp", "name": "My MCP", "url": "https://mcp.example.com", "type": "sse",
  "oauth": {
    "clientId": "my-pre-registered-client",
    "tokenUrl": "https://auth.example.com/oauth/token",
    "deviceAuthorizationUrl": "https://auth.example.com/oauth/device_authorization",
    "scopes": ["read", "write"]
  }
}
```
