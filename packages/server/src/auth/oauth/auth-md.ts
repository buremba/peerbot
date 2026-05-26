/**
 * The auth.md agent-registration document (https://auth.md style).
 *
 * Served as Markdown at GET /auth.md. It tells an agent how to register on a
 * user's behalf against this Lobu deployment. We implement only the
 * "user_claimed" flow (email confirmation via magic link) on top of the
 * standard OAuth device-code grant — there is no ID-JAG "agent_verified" flow.
 *
 * The document is generated from the deployment's base URL so the endpoint
 * examples are correct for self-hosted installs, not just lobu.ai.
 */
export function buildAuthMd(baseUrl: string): string {
  return `# auth.md

This document tells an agent how to register on a user's behalf against this
Lobu deployment. Resource server and authorization server are the same origin:
\`${baseUrl}\`.

We support one registration flow today: **user_claimed** — the agent supplies
the user's email and the user confirms via a one-click magic link. There is no
agent-attested (ID-JAG) zero-touch flow; do not attempt one.

## Discover

- Protected Resource Metadata: \`GET ${baseUrl}/.well-known/oauth-protected-resource\`
  (also surfaced via the \`WWW-Authenticate\` header on a 401).
- Authorization Server Metadata: \`GET ${baseUrl}/.well-known/oauth-authorization-server\`.
  The \`agent_auth\` block lists the endpoints and \`flows_supported\` for agent
  registration.

## Register (user_claimed)

1. Register a client (RFC 7591):
   \`\`\`http
   POST ${baseUrl}/oauth/register
   Content-Type: application/json

   { "client_name": "<your agent>", "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] }
   \`\`\`
   Response includes \`client_id\` (and \`client_secret\`).

2. Start a device authorization (RFC 8628):
   \`\`\`http
   POST ${baseUrl}/oauth/device_authorization
   Content-Type: application/json

   { "client_id": "<client_id>", "scope": "mcp:read mcp:write" }
   \`\`\`
   Response includes \`device_code\`, \`user_code\`, and a poll \`interval\`.

3. Deliver the request to the user by email:
   \`\`\`http
   POST ${baseUrl}/oauth/device/email
   Content-Type: application/json

   { "user_code": "<user_code>", "email": "<user email>" }
   \`\`\`
   Always returns \`202\` once the \`user_code\` is valid. The response never
   reveals whether the email already has an account. Lobu emails the user a
   magic link; one click signs them in (creating the account on first use) and
   lands them on the consent screen for this request.

4. Poll the token endpoint until the user approves:
   \`\`\`http
   POST ${baseUrl}/oauth/token
   Content-Type: application/json

   { "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "<device_code>", "client_id": "<client_id>" }
   \`\`\`
   While pending you get \`{ "error": "authorization_pending" }\` (back off on
   \`slow_down\`). On approval you get \`access_token\` (+ \`refresh_token\`),
   scoped to what the user granted.

## Use the credential

Send \`Authorization: Bearer <access_token>\` to the API / MCP endpoint. Refresh
with the standard \`refresh_token\` grant at \`${baseUrl}/oauth/token\`.

## Errors

| error | where | meaning |
| --- | --- | --- |
| \`authorization_pending\` | token poll | user has not approved yet; keep polling |
| \`slow_down\` | token poll | poll less often |
| \`expired_token\` | token poll | the device_code expired; start over |
| \`invalid_grant\` | device/email, token | unknown or expired \`user_code\`/\`device_code\` |
| \`access_denied\` | token poll | the user denied the request |
`;
}
