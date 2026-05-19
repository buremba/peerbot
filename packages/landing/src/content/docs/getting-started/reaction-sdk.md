---
title: Reaction SDK
description: Run TypeScript code after a watcher extracts data — post to Slack, write derived events, update entities.
---

A **reaction** is TypeScript code that runs *after* a watcher's LLM extraction completes. The default watcher path is: LLM extracts data → Lobu validates against the schema → result is persisted to memory. Adding a reaction lets you take imperative actions on top of that — post a Slack message, write a derived event, update an entity, send mail — before the run lands in the durable log.

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

## Minimal reaction

A reaction is a default-exported async function. The runtime invokes it with `(ctx, client)` after a watcher window completes.

```ts
import type { ReactionContext } from "@lobu/connector-sdk";

interface HealthData {
  account_changes?: Array<{
    account: string;
    previous_risk: "low" | "medium" | "high";
    current_risk: "low" | "medium" | "high";
    signals: string[];
  }>;
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

export default async (ctx: ReactionContext, client: any): Promise<void> => {
  const data = ctx.extracted_data as HealthData;
  const escalations = (data.account_changes ?? []).filter(
    (c) => RISK_ORDER[c.current_risk] > RISK_ORDER[c.previous_risk]
  );
  if (escalations.length === 0) return;

  for (const c of escalations) {
    await client.knowledge.save({
      entity_ids: ctx.entities.map((e) => e.id),
      content: `Account ${c.account}: risk ${c.previous_risk} → ${c.current_risk}\nSignals: ${c.signals.join("; ")}`,
      semantic_type: "health_change",
      metadata: {
        account: c.account,
        from: c.previous_risk,
        to: c.current_risk,
        window_id: ctx.window.id,
      },
    });
  }
};
```

This reaction sits alongside its watcher's account-health-monitor extraction and writes a `health_change` event only when risk gets worse, so the renewal-risk view and weekly digest have a stable, queryable record without re-deriving from the CRM stream.

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

The second argument is a `ClientSDK` injected by the sandbox. The exact surface lives in `packages/server/src/sandbox/client-sdk.ts`, but the methods reactions reach for most often are:

| API | What it does |
|-----|--------------|
| `client.knowledge.save({...})` | Append a new event to memory. Set `entity_ids` to attach to the right entities, `semantic_type` to classify it, `supersedes_event_id` to tombstone an earlier event. |
| `client.knowledge.search({...})` | Hybrid (vector + full-text) search across the org's events. Use for "have I seen this before?" checks before writing duplicates. |
| `client.knowledge.delete({...})` | Tombstone an event. Append-only: this writes a new superseding row, it never `DELETE`s. |
| `client.actions.*` | Call any registered platform action — `client.actions.slack.postMessage`, `client.actions.linear.createIssue`, etc. Routed through the gateway's connector proxy, so your code never holds the OAuth token. |

The sandbox times reactions out, sandboxes their network access through the worker proxy (so the same `WORKER_ALLOWED_DOMAINS` rules apply), and captures stdout/stderr to the run log.

## Where the file lives

In your Lobu project, drop the reaction next to the watcher it pairs with:

```
my-agent/
├── lobu.toml
├── models/
│   ├── watchers/
│   │   └── account-health-monitor.yaml
│   └── reactions/
│       └── account-health-monitor.reaction.ts
└── agents/my-agent/...
```

**The filename is the pairing.** `account-health-monitor.reaction.ts` runs after the `account-health-monitor` watcher. No registry, no config block — the slug match is the wiring.

If you don't want a reaction, don't create the file. The watcher's extraction still gets persisted; the reaction just doesn't fire.

## When to reach for a reaction

| Need | Reaction? |
|------|-----------|
| "Persist the LLM's output to memory" | No — the watcher already does that. |
| "Notify Slack when the LLM flags X" | Yes — call `client.actions.slack.postMessage` inside the reaction. |
| "Write a derived, denormalized event for fast querying" | Yes — `client.knowledge.save` with a distinct `semantic_type`. |
| "Mutate an external system based on extraction" | Yes — through `client.actions.*` so credentials stay in the gateway. |
| "Suppress some extractions" | Conditional `return;` early — no `save` call, no Slack post. Note the extraction itself still lands in the watcher window record. |

## Real-world example

- [`examples/sales/models/reactions/account-health-monitor.reaction.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/sales/models/reactions/account-health-monitor.reaction.ts) — filters worsening risk transitions out of a watcher's account-changes extraction and persists each one as a typed `health_change` event.

## See also

- [Connector SDK](/getting-started/connector-sdk/) — how external events arrive in the first place.
- [`@lobu/connector-sdk` reaction reference](/reference/reaction-sdk/) — every type a reaction can read.
- [Memory](/getting-started/memory/) — how reactions plug into the entity model.
