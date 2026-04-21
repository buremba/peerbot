---
title: Security
description: Isolation, network policy, credentials, and MCP proxy behavior.
---

Lobu is built so a compromised worker session cannot leak secrets or reach arbitrary networks. Secrets and outbound policy live on the gateway; workers run sandboxed with no ambient trust.

## Core Model

- **Per-session workers** — each conversation runs in its own sandboxed worker (pod in Kubernetes, container in Docker). Workspaces and state do not cross sessions.
- **Gateway is the control plane** — all outbound HTTP, credential resolution, tool policy, and MCP calls route through it.
- **Workers never see real secrets** — provider credentials are replaced with opaque placeholder tokens; the gateway's secret proxy swaps them back before forwarding to upstream APIs.

## Network Isolation

Workers have no direct route to the internet.

- **Docker**: two networks — `lobu-public` (gateway ingress) and `lobu-internal` (worker ↔ gateway only). The internal network is marked `internal: true`, so no egress route exists at the Docker layer.
- **Kubernetes**: `NetworkPolicies` restrict worker egress to the gateway. Optional runtime hardening via **gVisor**, **Kata Containers**, or **Firecracker** microVMs when the cluster supports it.

All worker outbound HTTP goes through the gateway's HTTP proxy on port **8118** (`HTTP_PROXY=http://gateway:8118`). Domain access is controlled by env vars:

| Variable | Behavior |
|---|---|
| `WORKER_ALLOWED_DOMAINS` | unset/empty → no access (default). `*` → unrestricted. Otherwise a comma-separated allowlist. |
| `WORKER_DISALLOWED_DOMAINS` | Blocklist, applied when `WORKER_ALLOWED_DOMAINS=*`. |

Domain format: exact (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

## Credentials

Workers never receive raw provider credentials or OAuth tokens. The gateway resolves credentials, injects them only at proxy time, and keeps workers on opaque placeholders or agent-scoped proxy URLs.

| Category | How it works | Where secret material can live |
|---|---|---|
| Provider secrets | Standalone `lobu run` can read from `.env` / `$ENV_VAR` or `secret_ref`. Embedded mode can pass `key` / `secretRef` at startup or resolve credentials dynamically per request. | Built-in encrypted Redis-backed secret store, external refs such as `secret://...` or `aws-sm://...`, or a host-provided embedded secret store |
| Per-user MCP / OAuth tokens | Collected through device-auth and injected by the gateway MCP proxy per call. Integration auth for GitHub, Google, Linear, and similar services is handled through [Owletto](/getting-started/memory/). | Writable gateway secret store or host-provided embedded secret store |
| Redis role | Redis may be the built-in encrypted secret store, or it may hold only metadata and `secretRef` pointers when secrets live elsewhere. | Redis-backed secret store or metadata only |

- **AWS Secrets Manager refs are read-only**. `aws-sm://...` works well for durable provider secret references, but refreshed user tokens still need a writable secret store.
- **User-scoped provider credentials are supported in embedded mode**. A host app can resolve credentials at runtime from request context such as `userId` without persisting plaintext keys in Lobu state.
- **Workers never touch third-party OAuth tokens directly**. They call integrations through Owletto MCP tools and the gateway proxy.

For concrete config examples, see [Embedding](/deployment/embedding/), [AWS](/deployment/aws/), the [`lobu.toml` reference](/reference/lobu-toml/), and the [CLI reference](/reference/cli/).

## MCP Proxy

- Workers discover MCP tools through the gateway and call them with their own JWT token scoped to the agent.
- The proxy enforces **SSRF protection**: upstream MCP URLs that resolve to internal or private IP ranges are blocked.
- **Destructive tool approval**: per the MCP spec, tools without `readOnlyHint: true` or `destructiveHint: false` require user approval in-thread (`Allow once / 1h / 24h / Always / Deny`). The user's choice is recorded in the grant store.
- **Operator override**: `[agents.<id>.tools]` in `lobu.toml` accepts a `pre_approved` list of grant patterns (e.g. `/mcp/gmail/tools/list_messages`, `/mcp/linear/tools/*`) that bypass the approval card. This is operator-only — skills cannot set it — so the escape hatch is always visible in code review. See [Tool Policy](/guides/tool-policy/) and the [`lobu.toml` reference](/reference/lobu-toml/).

## Further Reading

See [docs/SECURITY.md](https://github.com/lobu-ai/lobu/blob/main/docs/SECURITY.md) for the detailed threat model and per-runtime controls.
