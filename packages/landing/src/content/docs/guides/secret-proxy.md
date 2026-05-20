---
title: Secret proxy
description: How the gateway keeps real credentials out of workers by swapping placeholder tokens for secrets at egress.
---

Workers run untrusted code: agent reasoning, connector logic, tool calls. A worker that is jailbroken, buggy, or shipping a malicious skill must never be able to read a raw provider key or OAuth token. The secret proxy is how Lobu guarantees that. The worker only ever holds an opaque placeholder, and the real value is substituted on the gateway as the outbound request leaves the host.

## The placeholder model

When the gateway hands a credential to a worker, it hands over a placeholder of the form `lobu_secret_<uuid>`, never the real value. From the worker's code the placeholder behaves like a normal string:

- For `env_keys` auth, the value you read from `ctx.config.<field>` is a placeholder.
- For `oauth` auth, `ctx.credentials.accessToken` is a placeholder.

Your connector or tool code uses it exactly as if it were the token (sets it as a header, puts it in a query string) and never has to know it isn't the real thing.

## Swap at egress

All worker outbound HTTP goes through the gateway's in-process proxy on `127.0.0.1:8118`. When a request leaves the proxy, the `secret-proxy` component scans it for `lobu_secret_<uuid>` placeholders and swaps each one for the real secret **just before** the bytes go upstream. The real value:

- never exists in the worker process's memory,
- never appears in worker logs, run records, or checkpoints,
- only lives, decrypted, in the gateway for the duration of the outbound request.

This composes with [network isolation](/guides/security/#network-isolation): on Linux production hosts the worker is wrapped in `systemd-run --user --scope` with `IPAddressDeny=any` plus `IPAddressAllow=127.0.0.1`, so a worker cannot open a socket that bypasses the proxy. That means it cannot reach a destination where its placeholders would be resolved to anything.

## Where secret material lives

The proxy resolves placeholders from the gateway's credential stores. Workers never touch these directly.

| Category | Resolved from |
|---|---|
| Provider secrets | The built-in Postgres-backed encrypted secret store, external refs (`secret://…`, `aws-sm://…`), or a host-provided embedded secret store. |
| Per-user MCP / OAuth tokens | Collected via device-auth and injected by the gateway MCP proxy per call. Integration auth (GitHub, Google, Linear, and similar) is handled by Lobu MCP servers. |

`aws-sm://…` refs are **read-only**, which is good for durable provider secrets, but refreshed user tokens still need a writable store (the built-in Postgres store or a writable host store).

## Defense in depth

The secret proxy keeps credentials *out* of the worker. The [`secret-scan` guardrail](/guides/guardrails/#built-in-guardrails) is the backstop for the other direction: if a worker ever does emit a credential-shaped string in its output (a key the user pasted into chat, a token printed by a tool), `secret-scan` trips on the output stream before it reaches the user.

## See also

- [Security](/guides/security/), the full isolation model.
- [Egress judge](/guides/egress-judge/), per-request judging of where workers can connect.
- [Guardrails](/guides/guardrails/), `secret-scan` and the rest of the policy layer.
- [MCP Proxy](/guides/mcp-proxy/), how per-user tokens are injected into MCP calls.
- [Connector SDK](/getting-started/connector-sdk/), how connector code receives placeholders for `env_keys` and `oauth` auth.
