---
title: Guardrails
description: Policy checks that gate user input, worker output, and tool calls. Built-ins, inline LLM judges, and operator overrides.
---

Guardrails are policy checks that run at three points in an agent turn: before a user message reaches the worker, before the worker's text reaches the user, and before a tool call is authorized. They are how you stop a worker from leaking a secret, echoing PII, or invoking a destructive tool, independent of the prompt, so a jailbroken or buggy worker still hits the same wall.

Each guardrail targets exactly one **stage** and returns a verdict. The gateway runs every enabled guardrail for a stage in parallel and acts on the first one that trips.

## Stages

| Stage | When it runs | What it inspects | On trip |
|---|---|---|---|
| `input` | User message to worker, before dispatch | The raw user message | Dispatch is skipped; the user gets `Message rejected: <reason>` |
| `output` | Worker text to user, per streaming delta | The worker's output text | The stream is disposed, the partial buffer dropped, and `Message blocked by guardrail: <reason>` is posted |
| `pre-tool` | Tool call, before authorization | The tool name plus serialized arguments | The worker receives `isError: true` with `Tool call blocked by policy.` |

The `pre-tool` block message is intentionally generic. The real reason is hidden from the worker because leaking *why* a tool was blocked is an evasion surface. The `input` and `output` reasons are surfaced to the user, who is trusted.

## How the runner behaves

`runGuardrails(registry, stage, enabled, ctx)` races all enabled guardrails for the stage:

- **First trip wins.** The runner short-circuits on the first guardrail that trips; the others keep running but their results are discarded.
- **Fail open.** A guardrail that *throws* is logged and treated as a pass. Guardrails that need halt-on-error semantics must catch their own errors and return `{ tripped: true }`. So an infrastructure failure (a judge API timeout, say) never wedges the turn; it weakens enforcement instead of blocking traffic.
- **No-op when empty.** If no guardrails are enabled for a stage, the runner returns immediately.

## Built-in guardrails

Three primitives ship from the gateway and are registered at boot. Reference them by name in `lobu.toml`.

| Name | Stage(s) | Catches |
|---|---|---|
| `secret-scan` | `output` | Credential-shaped strings in worker output: OpenAI keys (`sk-…`), GitHub PATs (`ghp_…`), AWS access keys (`AKIA…`), and JWT-shaped tokens. Cheap enough to run per streaming delta. |
| `pii-scan` | `input`, `output`, `pre-tool` | Emails, US-shaped phone numbers, and Luhn-valid 13-19 digit card-shaped runs. On `pre-tool` it scans the serialized tool arguments. |
| `forbidden-tools` | `pre-tool` | A hardcoded deny list: `delete_repo`, `delete_branch`, `drop_table`. |

`secret-scan` and `forbidden-tools` are stage-locked, so they only ever run at their natural stage. `pii-scan` is registered once per stage, so enabling `pii-scan` covers input, output, and pre-tool.

## Enabling guardrails

List built-in (or globally-registered) guardrail names on the agent in [`lobu.toml`](/reference/lobu-toml/):

```toml
[agents.assistant]
name = "assistant"
dir = "./agents/assistant"
guardrails = ["secret-scan", "pii-scan", "forbidden-tools"]
```

Names that don't resolve to a guardrail registered in the gateway's `GuardrailRegistry` at startup are logged and skipped. A typo silently disables protection rather than failing the boot, so check the startup logs after changing this list.

## Inline LLM judges

When a regex won't express the policy, attach an ad-hoc LLM-judge guardrail with `[[agents.<id>.guardrails_inline]]`. Each entry names a stage and a judge prompt; the gateway materializes it into a guardrail at resolve time.

```toml
[[agents.assistant.guardrails_inline]]
stage = "output"
judge = "Never mention competitor product names."

[[agents.assistant.guardrails_inline]]
stage = "pre-tool"
tools = ["github.delete_repo"]
judge = "Only allow when the issue reference matches the active sprint."
```

- `stage` is one of `input`, `output`, `pre-tool`.
- `tools` narrows a `pre-tool` judge to specific tool names; it is ignored for other stages.
- `judge` is the policy text the LLM evaluates the stage context against.

Inline judges run through a shared judge client with a verdict cache and a circuit breaker that fails closed after repeated failures (the same machinery as the [egress judge](/guides/egress-judge/)). Each inline entry materializes into a guardrail named `inline:<stage>:<hash8>`, so operators can target it for disabling.

## Skill-provided guardrails

A skill can declare its own `pre-tool` guardrails in its `SKILL.md`, either a built-in by name or an inline judge. These are added when the skill is enabled, so a skill that ships a destructive tool can also ship the policy that gates it. Skill-declared inline judges are named `skill:<name>:inline:pre-tool:<hash8>`.

Skills can only add `pre-tool` guardrails. They cannot weaken input/output policy.

## Operator overrides

The full set for an agent is the union of enabled built-ins, skill-provided guardrails, and inline judges, deduplicated by name within each stage. The operator's exclude list is applied **last** and wins:

```toml
[agents.assistant]
guardrails_disabled = [
  "pii-scan",                              # turn off a built-in
  "skill:github:inline:pre-tool:1a2b3c4d", # turn off a skill's judge
]
```

`guardrails_disabled` matches against each guardrail's resolved `.name`, including the synthesized `inline:<stage>:<hash8>` and `skill:<name>:inline:pre-tool:<hash8>` names. Because it is operator-only and applied last, it is the single override point: a skill cannot re-enable something an operator disabled.

The merge happens in `resolveAgentGuardrails()`; see `packages/server/src/gateway/guardrails/aggregator.ts` and `judge-factory.ts` for the resolution order, judge cache, and circuit breaker.

## Auditing

Every trip, at any stage, built-in or judge, writes an event with `semantic_type='guardrail-trip'`, so operators can review what fired and why without the worker or user seeing the internal reason. The trip is recorded even though the `pre-tool` reason is hidden from the worker.

## See also

- [Egress judge](/guides/egress-judge/), the per-request LLM judge for outbound network access. Shares the judge cache and circuit-breaker machinery.
- [Tool Policy](/guides/tool-policy/), MCP tool approval and `pre_approved` overrides, the layer that sits alongside `pre-tool` guardrails.
- [Secret proxy](/guides/secret-proxy/), how `secret-scan` complements credential isolation at egress.
- [`lobu.toml` reference](/reference/lobu-toml/), the `guardrails`, `guardrails_inline`, and `guardrails_disabled` keys.
