# Security

Lobu's security model: what's isolated, what's trusted, and how deployment mode changes the controls.

## Threat Model

Assumptions:
- The agent executes untrusted LLM-generated code and fetches untrusted dependencies.
- Skills and MCP servers can be third-party.
- Users in different channels/DMs must never read or write each other's workspaces or secrets.

Goals:
- Contain compromise to a single worker/session.
- Centralize secrets and outbound-access decisions in the gateway.

## Kubernetes

- **Pod isolation** — per-session worker pods with constrained resources.
- **NetworkPolicies** — workers are not publicly reachable; egress is constrained to the gateway proxy.
- **RBAC** — the gateway has minimum permissions to create/delete worker resources.
- **Runtime hardening** — runs with **gVisor** (GCP) or **Kata Containers** / Firecracker microVMs where available.
- **PVC per session** — each session gets its own persistent volume.

## Docker Compose

- **Internal network** — workers run on `lobu-internal` (`internal: true`), no host network exposure.
- **Gateway as sole egress** — workers route outbound through the gateway HTTP proxy.
- **Scoped workspaces** — per-worker volumes, no cross-session mixing.

## Network Egress

Workers have no direct internet. All outbound traffic goes through the gateway HTTP proxy, which enforces:
- **Allowlist mode** — only configured domains reachable.
- **Blocklist mode** — allow all except denied domains.

## Credentials

- Provider credentials and client secrets live on the gateway.
- MCP credentials are resolved per-user via device-auth and injected by the gateway proxy at call time.
- Third-party API auth (GitHub, Google, etc.) is handled by Owletto — workers call these through Owletto MCP tools and never see OAuth tokens.
- Workers receive only the minimum scoped tokens required, and only via the proxy.

A compromised worker session cannot leak global platform tokens or MCP client secrets.

## Skills And Policy

Skills are executable, security-sensitive input:
- Use curated skill lists by default.
- Apply tool and network policy consistently across runtimes.
- Prefer reproducible environments (Nix) over ad-hoc installs.
