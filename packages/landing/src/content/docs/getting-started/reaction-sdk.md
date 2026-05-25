---
title: Reactions
description: Run TypeScript code after a watcher extracts data — post to Slack, write derived events, update entities.
---

Reactions are part of [`@lobu/connector-sdk`](/reference/connector-sdk/) — they're the typed hook you write to take action *after* a watcher's LLM extraction completes (there is no separate `@lobu/reaction-sdk` npm package). The default watcher path is: LLM extracts data → Lobu validates against the schema → result is persisted to memory. Adding a reaction lets you do imperative work on top of that — post a Slack message, write a derived event, mutate an external system — before the run lands in the durable log.

Reactions are optional. A watcher without one is pure extraction; a watcher with one is extraction + a typed hook.

## Install

The reaction surface ships inside `@lobu/connector-sdk`:

```bash
bun add @lobu/connector-sdk
```

You only need the `ReactionContext` type at authoring time:

```ts
import type { ReactionContext } from "@lobu/connector-sdk";
```

The `client` runtime is injected by the Lobu sandbox at execution time — there's nothing to import for it.

## A typed reaction, end to end

A reaction is a default-exported async function. The runtime invokes it with `(ctx, client)` after a watcher window completes.

The example below pairs with a `critical-detection` watcher whose `extraction_schema` produces a `CriticalDetection` payload. When the LLM flags severity `critical`, the reaction posts to a Slack incoming webhook and writes a derived `incident` event so dashboards have a stable row to count.

```ts
import type { ReactionContext } from "@lobu/connector-sdk";

// The shape the watcher's `extraction_schema` produces. The schema lives
// in YAML; we mirror it as a TypeScript interface so the reaction is
// fully typed against the same contract.
interface CriticalDetection {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  evidence_event_ids?: number[];
}

// Slack incoming webhook URL is provisioned per-org and surfaced to the
// reaction via the watcher's metadata bag.
interface ReactionParams {
  slack_webhook_url?: string;
}

export default async (
  ctx: ReactionContext,
  client: { knowledge: { save: (input: Record<string, unknown>) => Promise<unknown> } },
  params?: ReactionParams,
): Promise<void> => {
  const detection = ctx.extracted_data as unknown as CriticalDetection;
  if (detection.severity !== "critical") return;

  // 1. Notify Slack via the org's incoming webhook.
  const webhook = params?.slack_webhook_url;
  if (webhook) {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:rotating_light: *${ctx.watcher.name}* — ${detection.summary}`,
      }),
    });
  }

  // 2. Persist a derived `incident` event so the renewal-risk view and
  //    weekly digest have a queryable record without re-extracting.
  await client.knowledge.save({
    entity_ids: ctx.entities.map((e) => e.id),
    content: `[${detection.severity.toUpperCase()}] ${detection.summary}`,
    semantic_type: "incident",
    metadata: {
      severity: detection.severity,
      window_id: ctx.window.id,
      evidence_event_ids: detection.evidence_event_ids ?? [],
    },
  });
};
```

A few notes:

- **The `client` argument is typed inline.** There is no exported `ClientSDK` type from `@lobu/connector-sdk` (the runtime shape lives in `packages/server/src/sandbox/client-sdk.ts`). Declare the subset you actually call — the example above pins just `client.knowledge.save` — and TypeScript will catch typos at the call site without any `as any`.
- **`ctx.extracted_data` is typed as `Record<string, unknown>`** because the watcher's `extraction_schema` lives in YAML and TypeScript can't see it. Cast once to your interface at the top of the function and you're done.
- **Network calls follow the gateway's egress policy.** The Slack webhook host must be in the agent's `WORKER_ALLOWED_DOMAINS` (or routed through the egress judge) — see [Network](https://github.com/lobu-ai/lobu/blob/main/AGENTS.md#network).

## `ReactionContext`

The first argument. Read-only — every field comes from the watcher run that just completed.

| Field | Type | Description |
|------|------|-------------|
| `extracted_data` | `Record<string, unknown>` | The LLM's output, validated against the watcher's `extraction_schema`. Cast to a typed interface in your reaction. |
| `entities` | `ReactionEntity[]` | Every entity the watcher is attached to. Each has `id`, `name`, `entity_type`, and `metadata`. |
| `window` | object | The window that was just analyzed: `id`, `watcher_id`, `window_start`, `window_end`, `granularity`, `content_analyzed`. |
| `watcher` | object | Watcher identity: `id`, `slug`, `name`, `version`. Use `slug` for log lines you'll grep on. |
| `organization_id` | `string` | Org UUID. Useful when calling out to external systems that need org-scoping. |

The full type is at [`reference/reaction-sdk` › ReactionContext](/reference/reaction-sdk/#reactioncontext).

## The `client` runtime

The second argument is a `ClientSDK` injected by the sandbox. The exact surface lives in `packages/server/src/sandbox/client-sdk.ts`. The most useful pieces for reactions:

| API | What it does |
|-----|--------------|
| `client.knowledge.save({...})` | Append a new event to memory. Set `entity_ids` to attach to the right entities, `semantic_type` to classify it, `supersedes_event_id` to tombstone an earlier event. |
| `client.knowledge.search({...})` | Hybrid (vector + full-text) search across the org's events. Use for "have I seen this before?" checks before writing duplicates. |
| `client.knowledge.delete({...})` | Tombstone an event. Append-only: this writes a new superseding row, it never `DELETE`s. |
| `client.knowledge.read({...})` | Fetch a single event by id, or pull the events that were in the watcher's window. |

For side effects on external systems (Slack, Linear, GitHub), call those APIs directly with `fetch` — credentials live in the connector's `auth_profile`, not on the reaction.

The sandbox times reactions out, sandboxes their network access through the worker proxy (so the same `WORKER_ALLOWED_DOMAINS` rules apply), and captures stdout/stderr to the run log.

## Where the file lives

In your Lobu project, drop the reaction next to the watcher it pairs with:

```
my-agent/
├── lobu.config.ts
├── reactions/
│   └── critical-detection.reaction.ts
└── agents/my-agent/...
```

**The watcher names its reaction.** Point a watcher at a reaction with the `reaction` field in `defineWatcher`:

```ts
import { defineWatcher } from "@lobu/cli/config";

const criticalDetection = defineWatcher({
  agent: myAgent,
  slug: "critical-detection",
  prompt: "Flag any critical incidents.",
  extractionSchema: { type: "object", properties: {} },
  reaction: "./reactions/critical-detection.reaction.ts",
});
```

The path is relative to the config file and must stay under the project directory. Keeping the reaction in its own `.ts` file (not inline) means your editor type-checks it.

If you don't want a reaction, omit the `reaction` field. The watcher's extraction still gets persisted; the reaction just doesn't fire.

## When to reach for a reaction

| Need | Reaction? |
|------|-----------|
| "Persist the LLM's output to memory" | No — the watcher already does that. |
| "Notify Slack when the LLM flags X" | Yes — `fetch` the Slack incoming webhook inside the reaction. |
| "Write a derived, denormalized event for fast querying" | Yes — `client.knowledge.save` with a distinct `semantic_type`. |
| "Mutate an external system based on extraction" | Yes — `fetch` the target API; the worker's egress policy still applies. |
| "Suppress some extractions" | Conditional `return;` early — no `save` call, no notification. Note the extraction itself still lands in the watcher window record. |

## See it in production

- [`examples/sales/account-health-monitor.reaction.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/sales/account-health-monitor.reaction.ts) — filters worsening risk transitions out of a watcher's account-changes extraction and persists each one as a typed `health_change` event.

## See also

- [Connector SDK](/getting-started/connector-sdk/) — how external events arrive in the first place.
- [Reactions reference](/reference/reaction-sdk/) — every type a reaction can read, all exported from `@lobu/connector-sdk`.
- [Memory](/getting-started/memory/) — how reactions plug into the entity model.
