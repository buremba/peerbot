---
title: Reactions
description: Type reference for reactions — ReactionContext, ReactionEntity, and the injected client SDK surface, all from @lobu/connector-sdk.
sidebar:
  order: 6
---

API reference for the **reactions** surface of [`@lobu/connector-sdk`](/reference/connector-sdk/). Reactions are TypeScript files that run after a watcher's extraction lands; for a tutorial-style introduction see the [Reactions guide](/getting-started/reaction-sdk/).

All reaction types live in `@lobu/connector-sdk` — there is no separate `@lobu/reaction-sdk` package on npm. Import them by name:

```ts
import type { ReactionContext, ReactionEntity } from "@lobu/connector-sdk";
```

The matching `client` runtime is injected by the Lobu sandbox at execution time. It is **not importable** — its shape lives in `packages/server/src/sandbox/client-sdk.ts` and only the context types are shared across packages.

---

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
| `ctx` | The watcher-window context — extraction output, attached entities, window metadata. |
| `client` | The `ClientSDK` instance injected by the sandbox. Use `client.knowledge.*` for memory reads/writes; use `fetch` for outbound HTTP. |
| `params` | Optional bag of reaction-specific parameters (rare — most reactions ignore this). |

Throwing fails the reaction run; the error is surfaced to the watcher run log. Returning `void` is success — there is no need to return the saved-event ID.

---

## `ReactionContext`

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
| `extracted_data` | The LLM's output, already validated against the watcher's `extraction_schema`. Cast to a concrete interface — TypeScript can't infer it for you, since the schema is YAML-defined. |
| `entities` | Every entity the watcher is attached to. Common pattern: `entity_ids: ctx.entities.map((e) => e.id)` when calling `client.knowledge.save`. |
| `window` | `window_start` / `window_end` are ISO strings; `granularity` matches the watcher's schedule (`1h`, `1d`, …). |
| `watcher` | `slug` is stable across version bumps — use it for grep-friendly log lines. |
| `organization_id` | Org UUID. Forward to external systems that need explicit org-scoping. |

---

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

---

## The injected `client`

Not exported from `@lobu/connector-sdk` — injected as the second argument at runtime. The shape lives in `packages/server/src/sandbox/client-sdk.ts`. Below is the subset reactions reach for in practice.

### `client.knowledge`

| Method | Use |
|--------|-----|
| `save({ entity_ids?, content, semantic_type, title?, slug?, metadata? })` | Append a new event to memory. |
| `search({ query?, entity_type?, entity_id?, limit?, ... })` | Hybrid (vector + full-text) search across the org's events. Use to dedupe before writing. |
| `read({ content_id? \| watcher_id?, entity_ids?, since?, until?, limit? })` | Fetch a single event by id, or pull events from a watcher window. |
| `delete(event_id)` or `delete({ event_id?, event_ids?, reason? })` | Append a tombstone for one or more events. `events` is append-only — `delete` writes a superseding row, never `DELETE`s. |

### Outbound HTTP

Reactions hit external systems (Slack incoming webhooks, Linear, GitHub) directly with `fetch`. The worker proxy enforces the same `WORKER_ALLOWED_DOMAINS` policy as connector code, so non-allowlisted hosts are blocked at the network layer — no extra wrapper required.

When you need to call a third-party API that an installed connector already authenticates, fetch the token through the gateway proxy instead of duplicating credentials in the reaction.

---

## Lifecycle

1. **Watcher window closes.** The watcher's prompt + `extraction_schema` runs against the events in the window; the extracted JSON is validated.
2. **Lobu runs the watcher's reaction.** The watcher's `reaction` script (the `.ts` file referenced by `defineWatcher({ reaction: reactionFromFile("./account-health-monitor.reaction.ts") })`) runs. If the watcher declares no `reaction`, the run ends here.
3. **Sandbox boots the reaction.** Isolated worker, network restricted by the agent's `WORKER_ALLOWED_DOMAINS`, stdout/stderr captured into the run record, hard timeout.
4. **Reaction runs.** Any `client.knowledge.save` calls append events; outbound `fetch` calls go through the worker HTTP proxy.
5. **Result lands.** Success or failure is recorded on the watcher run; partial side effects (events already saved before a throw) stay in place — they're real events in the durable log.

---

## See also

- [Reactions guide](/getting-started/reaction-sdk/) — when to reach for a reaction, where the file lives, real-world example.
- [`@lobu/connector-sdk` reference](/reference/connector-sdk/) — the connector surface of the same package.
- [Memory](/getting-started/memory/) — how events become entity memory.
