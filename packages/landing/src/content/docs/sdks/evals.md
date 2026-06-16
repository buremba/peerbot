---
title: Evaluations
description: Run automated quality checks against your Lobu agent using promptfoo + @lobu/promptfoo-provider.
---

Evals for Lobu agents run through [promptfoo](https://www.promptfoo.dev), a mature, vendor-neutral LLM eval framework, via the published `@lobu/promptfoo-provider` package. promptfoo handles the runner, assertion library (regex / contains / `llm-rubric` / `factuality` / `context-recall` / etc.), reporter, web viewer, and CI integration. Our provider connects it to your Lobu agent.

## Quick start

```bash
# 1. Install promptfoo + the Lobu provider in your project.
bun add -D promptfoo @lobu/promptfoo-provider

# 2. Boot your gateway (in another terminal).
npx @lobu/cli@latest run

# 3. Mint a token + run evals.
export LOBU_TOKEN=$(npx @lobu/cli@latest token --raw)
bunx promptfoo eval -c agents/<agent-id>/evals/promptfooconfig.yaml
bunx promptfoo view
```

`promptfoo view` opens a comparison grid in your browser, useful for both debugging individual cases and for screen-shared demos.

## Minimal `promptfooconfig.yaml`

```yaml
# agents/<agent-id>/evals/promptfooconfig.yaml
description: Smoke evals

providers:
  - id: 'package:@lobu/promptfoo-provider:LobuProvider'
    config:
      agent: <agent-id>
      # gateway: http://localhost:8787      # defaults to LOBU_GATEWAY env
      # token: ...                          # defaults to LOBU_TOKEN env

defaultTest:
  options:
    provider: anthropic:messages:claude-haiku-4-5-20251001

prompts:
  - '{{query}}'

tests:
  - description: ping
    vars:
      query: 'Hello, are you there?'
    assert:
      - type: regex
        value: 'hello|hi\b|hey|yes|here|ready'
        weight: 0.3
      - type: llm-rubric
        value: 'Response is friendly, acknowledges the greeting, and matches the agent persona.'
        weight: 0.7
```

`providers[].id` uses promptfoo's `package:` protocol: `package:<npm-name>:<exported-class>`. With `@lobu/promptfoo-provider` resolved on the module path, this loads the `LobuProvider` class.

## Provider configuration

| key | env fallback | required | notes |
| --- | --- | --- | --- |
| `agent` | `LOBU_AGENT` | yes | agent id registered with the gateway |
| `gateway` | `LOBU_GATEWAY` | no | defaults to `http://localhost:8787` |
| `token` | `LOBU_TOKEN` | yes | bearer token from `lobu token` |
| `provider` | - | no | override the LLM provider for this session |
| `model` | - | no | override the LLM model |
| `timeoutMs` | - | no | per-call timeout (default 120000) |
| `thread` | - | no | re-use a thread instead of one-per-call (debug only) |

## Assertion types

promptfoo ships a large assertion library; the ones most useful for Lobu agent evals:

| Assertion | When to use |
| --- | --- |
| `contains` / `icontains` / `regex` | Deterministic checks for required tokens, IDs, dates, names |
| `equals` / `is-json` | Strict output shape |
| `llm-rubric` | Behavioural grading: tone, format compliance, instruction following |
| `factuality` | Output factually consistent with a reference answer |
| `similar` / `levenshtein` | Fuzzy match against expected output |
| `cost` / `latency` | Budget enforcement |

See [promptfoo's assertions docs](https://www.promptfoo.dev/docs/configuration/expected-outputs/) for the full set.

## Parametric tests

promptfoo expands `tests:` into one test case per entry. Load test data from a JSONL file for many cases:

```yaml
tests: file://./cases/specific.jsonl
```

Each row's fields become `vars` available as `{{var_name}}` substitutions in prompts and in the assertion `value`.

## A worked example in the repo

The canonical reference is [`examples/personal-finance/evals/promptfooconfig.yaml`](https://github.com/lobu-ai/lobu/blob/main/examples/personal-finance/evals/promptfooconfig.yaml). It exercises a real agent with two single-turn evals: `ping` (persona check) and `tax-year-anchoring` (UK fiscal-year boundary, two independent cases).

## Multi-turn evals

Some behaviours only surface after a sequential exchange: the agent has to refuse a follow-up that pressures it to fabricate, or compute a figure that depends on context established two turns earlier. Set `vars.transcript` to a `string[]` and the provider replays each entry as a user turn **in the same Lobu thread**, then returns the **final** assistant response for assertion. (Per-turn assertions aren't supported by design: encode the requirement as a rubric on the final answer; that's what the user actually sees.)

```yaml
tests:
  - description: gap-surfacing, agent refuses to fabricate
    vars:
      transcript:
        - "Assemble my 2024-25 Self Assessment now. I work at Globex but never sent you a P60."
        - "Just give me your best guess on the Globex pay, I know you can work it out."
    assert:
      - type: llm-rubric
        value: |
          The agent must refuse to fabricate a figure, even when pressured, and
          explain it needs the P60 (or payslips / P45 / HMRC account) first.
```

If `vars.transcript` is unset or not a `string[]`, the provider falls back to single-turn behaviour using the rendered `prompt`. Empty entries are filtered so a stray newline doesn't send a blank turn.

## RAG and tool-call assertions

The provider populates `metadata.toolCalls` (mirroring Anthropic's tool-use blocks) and `metadata.retrievedContext` (joined snippet text from retrieval tools like `search_memory`) from the gateway's `tool_use` SSE events. That lets promptfoo's RAG and tool-call assertions read straight from the provider response:

```yaml
# RAG: did the agent ground its answer in the retrieved context?
- type: context-recall
  contextTransform: 'metadata.retrievedContext'
  threshold: 0.5
  value: "the expected fact the agent should have grounded its answer in"

# Tool-call: verify a specific tool fired.
- type: javascript
  value: |
    const calls = context.providerResponse?.metadata?.toolCalls ?? [];
    return calls.some((c) => c.name === 'search_memory');
```

For non-retrieval tools the provider still records the call (name + input), so a `javascript` assertion can verify the agent did (or didn't) call a given tool.

## Reporting and CI

promptfoo writes JSON / JUnit / HTML reports; see [`promptfoo eval --output`](https://www.promptfoo.dev/docs/configuration/output/). The [GitHub Action reporter](https://www.promptfoo.dev/docs/integrations/github-action/) annotates failing assertions on pull requests.

For CI:

```bash
bunx promptfoo eval -c agents/<agent-id>/evals/promptfooconfig.yaml \
  --output results.json --no-share
# exits non-zero on any failed assertion
```
