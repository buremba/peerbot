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
  output: string                  // final assistant text from the agent
  tokenUsage: { prompt, completion, total }
  metadata: {
    agent: string
    thread: string                // fresh per call by default
    traceId?: string              // W3C trace id from `traceparent` header
    toolCalls?: unknown[]         // see "Known limitations" below
    retrievedContext?: string     // see "Known limitations" below
  }
}
```

## Known limitations

**`metadata.toolCalls` / `metadata.retrievedContext` are not yet populated.**

The gateway's SSE protocol currently exposes only `output` / `complete` / `error` events to clients. Tool calls (e.g., the agent invoking `search_memory` and receiving event IDs) happen inside the worker but aren't surfaced over SSE. Until that changes:

- promptfoo's RAG-specific assertions that rely on `contextTransform: 'metadata.retrievedContext'` — `context-recall`, `context-faithfulness`, `answer-relevance` — won't have useful context to work with.
- Custom `javascript` assertions inspecting `metadata.toolCalls` will see `undefined`.

Workable assertions today: `contains`, `regex`, `equals`, `is-json`, `similar`, `levenshtein`, `llm-rubric`, `factuality`, `cost`, `latency`. These cover answer-quality and behavioral checks.

When the gateway adds a `tool_use` SSE event type, this provider will start populating `metadata.toolCalls` and (for `search_memory` specifically) `metadata.retrievedContext`. No promptfoo config change required.

## License

BUSL-1.1
