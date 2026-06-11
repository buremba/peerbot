---
title: Reactions
description: "Run TypeScript code after a watcher extracts data: post to Slack, write derived events, update entities."
---

Reactions are part of [`@lobu/connector-sdk`](/sdks/connectors-reference/): the typed hook you write to take action *after* a watcher's LLM extraction completes (there is no separate `@lobu/reaction-sdk` npm package). The default watcher path is: LLM extracts data → Lobu validates against the schema → result is persisted to memory. Adding a reaction lets you do imperative work on top of that (post a Slack message, write a derived event, mutate an external system) before the run lands in the durable log.

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

The `client` runtime is injected by the Lobu sandbox at execution time; there's nothing to import for it.

## A typed reaction, end to end

A reaction is a default-exported async function. The runtime invokes it with `(ctx, client, params?)` after a watcher window completes.

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
        text: `:rotating_light: *${ctx.watcher.name}*: ${detection.summary}`,
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

- **The `client` argument is typed inline.** There is no exported `ClientSDK` type from `@lobu/connector-sdk` (the runtime shape lives in `packages/server/src/sandbox/client-sdk.ts`). Declare the subset you actually call (the example above pins just `client.knowledge.save`) and TypeScript will catch typos at the call site without any `as any`.
- **`ctx.extracted_data` is typed as `Record<string, unknown>`** because the watcher's `extraction_schema` lives in YAML and TypeScript can't see it. Cast once to your interface at the top of the function and you're done.
- **Network calls follow the gateway's egress policy.** The Slack webhook host must be in the agent's `WORKER_ALLOWED_DOMAINS` (or routed through the egress judge); see [Network](https://github.com/lobu-ai/lobu/blob/main/AGENTS.md#network).

## Reaction signature

A reaction file default-exports an async function:

```ts
import type { ReactionContext } from "@lobu/connector-sdk";

// Declare the subset of the injected ClientSDK your reaction touches.
// `@lobu/connector-sdk` doesn't export `ClientSDK` (the implementation
// lives in the server package), so pin only what you call.
interface ReactionClient {
  knowledge: {
    save(input: {
      entity_ids?: number[];
      content: string;
      semantic_type: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export default async (
  ctx: ReactionContext,
  client: ReactionClient,
  params?: Record<string, unknown>,
): Promise<void> => {
  // …
};
```

| Argument | Description |
|----------|-------------|
| `ctx` | The watcher-window context: extraction output, attached entities, window metadata. |
| `client` | The `ClientSDK` instance injected by the sandbox. Use `client.knowledge.*` for memory reads/writes; use `fetch` for outbound HTTP. |
| `params` | Optional bag of reaction-specific parameters (rare; most reactions ignore this). |

Throwing fails the reaction run; the error is surfaced to the watcher run log. Returning `void` is success. There is no need to return the saved-event ID.

## `ReactionContext`

The first argument. Read-only: every field comes from the watcher run that just completed.

```ts
interface ReactionContext {
  /** The extracted analysis data from the completed window */
  extracted_data: Record<string, unknown>;

  /** All entities the watcher is attached to */
  entities: ReactionEntity[];

  /** The window that was just completed */
  window: {
    id: number;
    watcher_id: number;
    window_start: string;
    window_end: string;
    granularity: string;
    content_analyzed: number;
  };

  /** Watcher identity */
  watcher: {
    id: number;
    slug: string;
    name: string;
    version: number;
  };

  /** Organization context */
  organization_id: string;
}
```

| Field | Notes |
|-------|-------|
| `extracted_data` | The LLM's output, already validated against the watcher's `extraction_schema`. Cast to a concrete interface; TypeScript can't infer it for you, since the schema is YAML-defined. |
| `entities` | Every entity the watcher is attached to. Common pattern: `entity_ids: ctx.entities.map((e) => e.id)` when calling `client.knowledge.save`. |
| `window` | `window_start` / `window_end` are ISO strings; `granularity` matches the watcher's schedule (`1h`, `1d`, …). |
| `watcher` | `slug` is stable across version bumps; use it for grep-friendly log lines. |
| `organization_id` | Org UUID. Forward to external systems that need explicit org-scoping. |

## `ReactionEntity`

```ts
interface ReactionEntity {
  id: number;
  name: string;
  entity_type: string;
  metadata: Record<string, unknown>;
}
```

Each entity carries the org-scoped numeric `id` (use for `entity_ids` on `save`), the display `name`, the type slug (`Company`, `Project`, `$member`), and any `metadata` traits accreted by connector ingestion or earlier watchers.

## The injected `client`

The second argument is a `ClientSDK` injected by the sandbox. It is **not importable**: its shape lives in `packages/server/src/sandbox/client-sdk.ts` and only the context types are shared across packages. The subset reactions reach for in practice:

### `client.knowledge`

| Method | Use |
|--------|-----|
| `save({ entity_ids?, content, semantic_type, title?, slug?, metadata? })` | Append a new event to memory. Set `entity_ids` to attach to the right entities, `semantic_type` to classify it, `supersedes_event_id` to tombstone an earlier event. |
| `search({ query?, entity_type?, entity_id?, limit?, ... })` | Hybrid (vector + full-text) search across the org's events. Use to dedupe before writing. |
| `read({ content_id? \| watcher_id?, entity_ids?, since?, until?, limit? })` | Fetch a single event by id, or pull events from a watcher window. |
| `delete(event_id)` or `delete({ event_id?, event_ids?, reason? })` | Append a tombstone for one or more events. `events` is append-only: `delete` writes a superseding row, never `DELETE`s. |

### Outbound HTTP

For side effects on external systems (Slack incoming webhooks, Linear, GitHub), call those APIs directly with `fetch`. The worker proxy enforces the same `WORKER_ALLOWED_DOMAINS` policy as connector code, so non-allowlisted hosts are blocked at the network layer; no extra wrapper required. Credentials live in the connector's `auth_profile`, not on the reaction. When you need to call a third-party API that an installed connector already authenticates, fetch the token through the gateway proxy instead of duplicating credentials in the reaction.

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
import { defineWatcher, reactionFromFile } from "@lobu/cli/config";
import type criticalDetectionReaction from "./reactions/critical-detection.reaction.ts";

const criticalDetection = defineWatcher({
  agent: myAgent,
  slug: "critical-detection",
  prompt: "Flag any critical incidents.",
  extractionSchema: { type: "object", properties: {} },
  reaction: reactionFromFile<typeof criticalDetectionReaction>(
    "./reactions/critical-detection.reaction.ts"
  ),
});
```

The path is relative to the config file and must stay under the project directory. Passing the handler's type via the generic (`import type` + `reactionFromFile<typeof criticalDetectionReaction>`) is optional. Bare `reactionFromFile("./reactions/critical-detection.reaction.ts")` still works, but the typed form gives you go-to-definition, rename, and a `tsc` error if the reaction's default export drifts from the `(ctx, client, params?)` handler signature. The `import type` is erased at compile time, so the reaction module is never loaded while your config is evaluated.

If you don't want a reaction, omit the `reaction` field. The watcher's extraction still gets persisted; the reaction just doesn't fire.

## Lifecycle

1. **Watcher window closes.** The watcher's prompt + `extraction_schema` runs against the events in the window; the extracted JSON is validated.
2. **Lobu runs the watcher's reaction.** The `.ts` file referenced by `defineWatcher({ reaction: reactionFromFile("./critical-detection.reaction.ts") })` runs. If the watcher declares no `reaction`, the run ends here.
3. **Sandbox boots the reaction.** Isolated worker, network restricted by the agent's `WORKER_ALLOWED_DOMAINS`, stdout/stderr captured into the run record, hard timeout.
4. **Reaction runs.** Any `client.knowledge.save` calls append events; outbound `fetch` calls go through the worker HTTP proxy.
5. **Result lands.** Success or failure is recorded on the watcher run; partial side effects (events already saved before a throw) stay in place. They're real events in the durable log.

## When to reach for a reaction

| Need | Reaction? |
|------|-----------|
| "Persist the LLM's output to memory" | No. The watcher already does that. |
| "Notify Slack when the LLM flags X" | Yes. `fetch` the Slack incoming webhook inside the reaction. |
| "Write a derived, denormalized event for fast querying" | Yes. `client.knowledge.save` with a distinct `semantic_type`. |
| "Mutate an external system based on extraction" | Yes. `fetch` the target API; the worker's egress policy still applies. |
| "Suppress some extractions" | Conditional `return;` early: no `save` call, no notification. Note the extraction itself still lands in the watcher window record. |

## See it in production

- [`examples/sales/account-health-monitor.reaction.ts`](https://github.com/lobu-ai/lobu/blob/main/examples/sales/account-health-monitor.reaction.ts): filters worsening risk transitions out of a watcher's account-changes extraction and persists each one as a typed `health_change` event.

## See also

- [Connectors](/sdks/connectors/): how external events arrive in the first place.
- [`@lobu/connector-sdk` reference](/sdks/connectors-reference/): every exported symbol with types.
- [Memory](/getting-started/memory/): how reactions plug into the entity model.
