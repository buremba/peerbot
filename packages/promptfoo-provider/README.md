# @lobu/promptfoo-provider

A [promptfoo](https://www.promptfoo.dev) custom provider that drives a Lobu agent end-to-end via the gateway's public Agent API. Use it to run promptfoo evals against any agent running on a Lobu deployment (local `lobu run` or Lobu Cloud).

## Install

```bash
bun add -D promptfoo @lobu/promptfoo-provider
```

## Use

```yaml
# agents/<id>/evals/promptfooconfig.yaml
providers:
  - id: '@lobu/promptfoo-provider'
    config:
      agent: my-agent          # required — agent id registered on the gateway
      # gateway, token come from LOBU_GATEWAY / LOBU_TOKEN env by default

prompts:
  - '{{query}}'

tests:
  - vars: { query: 'hello' }
    assert:
      - { type: contains, value: 'hi' }
```

Then:

```bash
export LOBU_GATEWAY=http://localhost:8787
export LOBU_TOKEN=<your token>
promptfoo eval -c agents/<id>/evals/promptfooconfig.yaml
promptfoo view
```

## Config

| key | env fallback | required | notes |
| --- | --- | --- | --- |
| `agent` | `LOBU_AGENT` | yes | agent id registered with the gateway |
| `gateway` | `LOBU_GATEWAY` | no | defaults to `http://localhost:8787` |
| `token` | `LOBU_TOKEN` | yes | bearer token for the gateway |
| `provider` | — | no | overrides the LLM provider used by the agent for this session |
| `model` | — | no | overrides the LLM model |
| `timeoutMs` | — | no | per-call timeout (default 120000) |
| `thread` | — | no | re-use a thread instead of one-per-call (debug only) |

## What the provider returns

```ts
{
  output: string                    // final assistant text from the agent
  tokenUsage: { prompt, completion, total }
  metadata: {
    agent: string
    thread: string                  // fresh per call by default
    traceId?: string                // W3C trace id from `traceparent` header
    toolCalls?: LobuToolCall[]      // every tool call observed during the turn
    retrievedContext?: string       // joined snippet text from retrieval tools
  }
}
```

`toolCalls` mirrors Anthropic's tool-use blocks (`{ name, input, isError?, result_summary? }`) and is populated from the gateway's `tool_use` SSE event. For retrieval tools (`search_memory` / `lobu_search_memory`) the `result_summary` includes the matched event IDs plus the snippet text content, and the provider joins those texts into `metadata.retrievedContext` so promptfoo's RAG assertions can use it directly:

```yaml
# RAG assertion — promptfoo's `contextTransform` reads from the provider
# response's `metadata` field.
- type: context-recall
  contextTransform: 'metadata.retrievedContext'
  threshold: 0.5
  value: "the expected fact the agent should have grounded its answer in"

# Verify a specific tool was called. JS assertions receive the full provider
# response on `context.providerResponse`.
- type: javascript
  value: |
    const meta = context.providerResponse?.metadata ?? {};
    const calls = Array.isArray(meta.toolCalls) ? meta.toolCalls : [];
    return calls.some((c) => c.name === 'search_memory');
```

For non-retrieval tools the provider still records the call (name + input) so `javascript` assertions can verify that, e.g., the agent did or didn't call a destructive tool.

## License

BUSL-1.1
