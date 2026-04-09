---
title: Security
description: Core security model, secrets handling, and MCP proxy behavior.
---

Lobu is designed so agent execution is isolated while sensitive auth and network control stay centralized.

## Security Model

- Worker execution is isolated per conversation/session.
- Gateway is the control plane for routing, auth, and policy.
- Outbound traffic is policy-controlled through the gateway HTTP proxy (port 8118).

For deeper details, see the repository security document: [docs/SECURITY.md](https://github.com/lobu-ai/lobu/blob/main/docs/SECURITY.md).

## Secrets

- Provider credentials are managed on the gateway side. Integration auth (GitHub, Google, etc.) is handled by Owletto.
- Workers should not depend on long-lived raw credentials in their runtime context.
- Device-code auth flows and settings links are used to collect/refresh auth safely.

## Network Isolation

Lobu uses a two-network Docker architecture:

- **`lobu-public`**: gateway ingress (external traffic).
- **`lobu-internal`**: worker-to-gateway traffic only. Workers have no direct external route.

All worker outbound HTTP traffic routes through the gateway HTTP proxy on port 8118. Domain access is controlled by environment variables:

| Variable | Description |
|----------|-------------|
| `WORKER_ALLOWED_DOMAINS` | Domains workers can reach. Empty = no access. `*` = unrestricted. |
| `WORKER_DISALLOWED_DOMAINS` | Domains to block when `WORKER_ALLOWED_DOMAINS=*`. |

Domain format: exact match (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

## MCP Proxy

- Workers access MCP capabilities through gateway-managed MCP config/proxy paths.
- Per-user credentials are resolved via the device-auth flow and injected by the gateway proxy.
- The MCP proxy blocks requests to reserved IP ranges (SSRF protection).
- This keeps tool access extensible without exposing global secrets directly to workers.

## Permissions Section

Permissions are managed as domain-level policies (for example `Always`, `Session`, or time-limited access):

![Permissions section from homepage demo](/images/docs/security-permissions-section.png)
