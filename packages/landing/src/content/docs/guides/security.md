---
title: Security
description: Isolation, network policy, credentials, and MCP proxy behavior.
---

Lobu is built so a compromised worker session cannot leak secrets or reach arbitrary networks. Secrets and outbound policy live on the gateway; workers run sandboxed with no ambient trust.

## Core Model

- **Per-session workers** — each conversation runs in its own subprocess spawned by the gateway. Workspaces and state do not cross sessions; the subprocess can be SIGKILL'd cleanly without taking the gateway down.
- **Gateway is the control plane** — all outbound HTTP, credential resolution, tool policy, and MCP calls route through it.
- **Workers never see real secrets** — provider credentials are replaced with opaque placeholder tokens; the gateway's secret proxy swaps them back before forwarding to upstream APIs.

## Network Isolation

Workers route all outbound HTTP through the gateway's in-process proxy on **127.0.0.1:8118** (`HTTP_PROXY=http://localhost:8118`). On Linux production hosts the worker spawn is wrapped in `systemd-run --user --scope` with `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1`, which enforces the egress block at the kernel; on macOS dev hosts `HTTP_PROXY` is advisory at the language layer.

Domain access is controlled by env vars:

| Variable | Behavior |
|---|---|
| `WORKER_ALLOWED_DOMAINS` | unset/empty → no access (default). `*` → unrestricted. Otherwise a comma-separated allowlist. |
| `WORKER_DISALLOWED_DOMAINS` | Blocklist, applied when `WORKER_ALLOWED_DOMAINS=*`. |

Domain format: exact (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

### LLM-judged egress

For domains where flat allow/deny is too coarse — Slack, GitHub user-content, Notion — skills can route requests through an LLM judge that decides per request. Most traffic still bypasses the judge: only domains that match a `judge` rule invoke it, so the cost stays bounded.

Skills declare judged domains and named policies in `SKILL.md` frontmatter:

```yaml
network:
  allow: [api.readonly.example.com]      # flat allow, fast path
  judge:
    - .slack.com                          # uses the "default" policy
    - domain: user-content.x.com
      judge: strict                       # uses the named "strict" policy
judges:
  default: "Allow only reads to channels in the agent's context."
  strict:  "Only GET for file IDs from the current session."
```

Operators append a project-wide policy in `lobu.toml`:

```toml
[agents.<id>.egress]
extra_policy = "Never exfiltrate PATs or bearer tokens."
judge_model  = "claude-haiku-4-5-20251001"   # default
```

`extra_policy` is appended to the matched skill policy, so operator constraints compose with skill author intent rather than replacing it.

Behavior:

- **Defaults**: Haiku judge, 5-minute verdict cache keyed by `(policyHash, request signature)`, circuit breaker opens after 5 consecutive judge failures (30s cooldown) and fails closed.
- **Hostname-only for HTTPS CONNECT** (TLS tunnel is opaque); method + path inspected for plain HTTP.
- **Audit**: every decision emits a structured `egress-decision` log with verdict, source (`global | grant | judge`), latency, and policy hash. No request bodies/headers are logged.
- **Required**: `ANTHROPIC_API_KEY` in the gateway env. Gateways with no judged-domain rules never construct the judge client.

A working end-to-end example lives at [`examples/engineering/agents/engineering/skills/egress-guardrail/SKILL.md`](https://github.com/lobu-ai/lobu/blob/main/examples/engineering/agents/engineering/skills/egress-guardrail/SKILL.md).

## Credentials

Workers never receive raw provider credentials or OAuth tokens. The gateway resolves credentials, injects them only at proxy time, and keeps workers on opaque placeholders or agent-scoped proxy URLs.

| Category | How it works | Where secret material can live |
|---|---|---|
| Provider secrets | Standalone `lobu run` can read from `.env` / `$ENV_VAR` or `secret_ref`. Embedded mode can pass `key` / `secretRef` at startup or resolve credentials dynamically per request. | Built-in encrypted Redis-backed secret store, external refs such as `secret://...` or `aws-sm://...`, or a host-provided embedded secret store |
| Per-user MCP / OAuth tokens | Collected through device-auth and injected by the gateway MCP proxy per call. Integration auth for GitHub, Google, Linear, and similar services is handled through [Owletto](/getting-started/memory/). | Writable gateway secret store or host-provided embedded secret store |
| Redis role | Redis may be the built-in encrypted secret store, or it may hold only metadata and `secretRef` pointers when secrets live elsewhere. | Redis-backed secret store or metadata only |

- **AWS Secrets Manager refs are read-only**. `aws-sm://...` works well for durable provider secret references, but refreshed user tokens still need a writable secret store.
- **Workers never touch third-party OAuth tokens directly**. They call integrations through Owletto MCP tools and the gateway proxy.

For concrete config examples, see the [`lobu.toml` reference](/reference/lobu-toml/) and the [CLI reference](/reference/cli/).

## MCP Proxy

- Workers discover MCP tools through the gateway and call them with their own JWT token scoped to the agent.
- The proxy enforces **SSRF protection**: upstream MCP URLs that resolve to internal or private IP ranges are blocked.
- **Destructive tool approval**: per the MCP spec, tools without `readOnlyHint: true` or `destructiveHint: false` require user approval in-thread (`Allow once / 1h / 24h / Always / Deny`). The user's choice is recorded in the grant store.
- **Operator override**: `[agents.<id>.tools]` in `lobu.toml` accepts a `pre_approved` list of grant patterns (e.g. `/mcp/gmail/tools/list_messages`, `/mcp/linear/tools/*`) that bypass the approval card. This is operator-only — skills cannot set it — so the escape hatch is always visible in code review. See [Tool Policy](/guides/tool-policy/) and the [`lobu.toml` reference](/reference/lobu-toml/).

## Further Reading

See [docs/SECURITY.md](https://github.com/lobu-ai/lobu/blob/main/docs/SECURITY.md) for the detailed threat model and per-runtime controls.
