---
title: "@lobu/reaction-sdk"
description: Type reference for reaction scripts — ReactionContext, ReactionEntity, and the client SDK surface.
sidebar:
  order: 6
---

API reference for the reaction surface. Reactions are TypeScript files that run after a watcher's extraction lands; for a tutorial-style introduction see the [Reaction SDK guide](/getting-started/reaction-sdk/).

The reaction types ship inside [`@lobu/connector-sdk`](/reference/connector-sdk/) — there is no separate `@lobu/reaction-sdk` package on npm, just a stable named entry point:

```ts
import type { ReactionContext, ReactionEntity } from "@lobu/connector-sdk";
```

The matching `client` runtime is injected by the Lobu sandbox at execution time. It is **not importable** — its shape lives in `packages/server/src/sandbox/client-sdk.ts` and only the context types are shared across packages.

---

## Reaction signature

A reaction file default-exports an async function:

```ts
import type { ReactionContext } from "@lobu/connector-sdk";

export default async (
  ctx: ReactionContext,
  client: any,
  params?: Record<string, unknown>
): Promise<void> => {
  // …
};
```

| Argument | Description |
|----------|-------------|
| `ctx` | The watcher-window context — extraction output, attached entities, window metadata. |
| `client` | The `ClientSDK` instance injected by the sandbox. Use `client.knowledge.*` and `client.actions.*`. |
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
| `save({ entity_ids, content, semantic_type, metadata?, supersedes_event_id? })` | Append a new event. Pass `supersedes_event_id` to tombstone an earlier event (`events` is append-only — there's no real delete). |
| `search({ query, semantic_type?, entity_ids?, limit?, sort_by? })` | Hybrid (vector + full-text) search across the org's events. Use to dedupe before writing. |
| `delete({ event_id })` | Write a tombstone for `event_id`. Equivalent to `save({ supersedes_event_id: event_id, … })` with the platform-blessed defaults. |

### `client.actions.*`

Calls registered platform actions through the gateway's connector proxy — your reaction code never holds the OAuth token. Typical surfaces:

| Call | What it does |
|------|--------------|
| `client.actions.slack.postMessage({ channel, text, blocks? })` | Post into a Slack channel the org has connected. |
| `client.actions.linear.createIssue({ teamId, title, description })` | Open a Linear issue. |
| `client.actions.<connector>.<action>({...})` | Any action declared on a connector's `actions` map is reachable here, gated by per-action `requiresApproval`. |

The proxy enforces the same `WORKER_ALLOWED_DOMAINS` policy as the connector runtime, and an action with `requiresApproval: true` blocks until an operator approves it in the admin UI.

---

## Lifecycle

1. **Watcher window closes.** The watcher's prompt + `extraction_schema` runs against the events in the window; the extracted JSON is validated.
2. **Lobu looks for a paired reaction.** Filename match: a watcher with slug `account-health-monitor` pairs with `models/reactions/account-health-monitor.reaction.ts`. If no file exists, the run ends here.
3. **Sandbox boots the reaction.** Isolated worker, network restricted by the agent's `WORKER_ALLOWED_DOMAINS`, stdout/stderr captured into the run record, hard timeout.
4. **Reaction runs.** Any `client.knowledge.save` calls append events; `client.actions.*` calls route through the gateway proxy.
5. **Result lands.** Success or failure is recorded on the watcher run; partial side effects (events already saved before a throw) stay in place — they're real events in the durable log.

---

## See also

- [Reaction SDK guide](/getting-started/reaction-sdk/) — when to reach for a reaction, where the file lives, real-world example.
- [`@lobu/connector-sdk` reference](/reference/connector-sdk/) — the connector side of the platform.
- [Memory](/getting-started/memory/) — how events become entity memory.
