---
title: Egress judge
description: Per-request LLM judging of worker outbound network access, for domains where a flat allow/deny is too coarse.
---

Workers route all outbound HTTP through the gateway proxy, which enforces a domain allowlist/blocklist (see [Security](/guides/security/#network-isolation)). For most domains a flat allow or deny is the right call. For a few, like Slack, GitHub user-content, and Notion, the domain is *sometimes* fine and *sometimes* exfiltration, and the difference is in the request, not the hostname. The egress judge decides those per request with an LLM.

Only domains that match a `judge` rule invoke the judge. Everything else stays on the fast allow/deny path, so the cost and latency stay bounded.

## Declaring judged domains

Skills declare judged domains and named policies in their `SKILL.md` frontmatter:

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

The same shape is available to operators in [`lobu.toml`](/reference/lobu-toml/) under `[agents.<id>.network]`, where the `judge` array takes either a bare domain string (which uses the `default` policy) or `{ domain, judge }` naming a policy.

## Operator overrides

Operators layer a project-wide policy on top of whatever the skill author declared:

```toml
[agents.assistant.egress]
extra_policy = "Never exfiltrate PATs or bearer tokens."
judge_model  = "claude-haiku-4-5-20251001"   # default
```

`extra_policy` is **appended** to the matched skill policy rather than replacing it, so operator constraints compose with skill-author intent. The judge runs only when a `judge` rule under `[agents.<id>.network]` matches a request, so most traffic never reaches it.

## Behavior

- **Defaults:** Haiku judge, a 5-minute verdict cache keyed by `(policyHash, request signature)`, and a circuit breaker that opens after 5 consecutive judge failures (30s cooldown) and **fails closed**.
- **What the judge sees:** for HTTPS the TLS tunnel is opaque, so the judge gets the **hostname only** (via the `CONNECT` request). For plain HTTP it also sees the method and path. Request bodies and headers are never inspected.
- **Audit:** every decision emits a structured `egress-decision` log with the verdict, source (`global | grant | judge`), latency, and policy hash. No request bodies or headers are logged.
- **Required env:** `ANTHROPIC_API_KEY` in the gateway environment. A gateway with no judged-domain rules never constructs the judge client.

The judge shares its cache and circuit-breaker machinery with [inline guardrail judges](/guides/guardrails/#inline-llm-judges). Hooks live in `packages/server/src/gateway/proxy/http-proxy.ts`.

## See also

- [Security](/guides/security/), the worker isolation and network model the judge sits inside.
- [Secret proxy](/guides/secret-proxy/), how credentials stay off the worker, the other half of egress safety.
- [Guardrails](/guides/guardrails/), input/output/pre-tool policy checks, including inline LLM judges.
- [`lobu.toml` reference](/reference/lobu-toml/), `[agents.<id>.network]` and `[agents.<id>.egress]`.
