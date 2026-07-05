# Virtual feed flag — Slice 2

Status: implemented (this PR). Conflict-safe slice of the larger "Conversation feeds
/ FeedReader registry" program. This slice ships the **capability layer + migration**
that lets a feed be *read live* instead of synced; the FeedReader registry + feed
enumeration that consume it land in a sibling stream (Stream A, owned separately).

Follow-up shipped: `query_sql` now warns that `events` queries are persisted-only
and suggests accessible live virtual feeds; `manage_feeds.read_feeds` /
`client.feeds.readMany` batch those live reads with per-feed partial failures.
See `docs/database-connectors.md` for the current agent-facing contract.

## Goal

Make a feed *declarable as virtual*: read LIVE against its source at request time via
the connector `query()` / `search()` pushdown, and NEVER synced (no events persisted,
no checkpoint, no schedule). This is the `(virtual-live-dataset, recall)` tuple in the
three-feed-kinds model — `KIND = virtual-live-dataset`, `LENS = recall` (keyword) or a
plain live read.

## Where this sits in the program (conflict-safe ordering)

- **Phase 0** — feed enumeration / `listConnectionFeeds` (Stream A owner). Not touched here.
- **Stream A** — the `FeedReader<S, L>` registry + recall-source wiring in
  `packages/server/src/tools/search.ts` (Stream A owner). Not touched here.
- **Slice 2 (this PR)** — declare `virtual` on a feed, persist it, skip it in the sync
  scheduler, add the connector `search()` recall capability, and expose a stable
  `readVirtualFeed(...)` pushdown seam. Stream A registers virtual as the
  `(virtual-live-dataset, recall)` tuple by calling that seam.
- **Stream B Phase 2** — virtual-feed UI (owletto). Not in this slice.

The single integration point between this slice and Stream A is the exported function
`readVirtualFeed` (below). Stream A imports and calls it; this slice never touches
`search.ts`.

## Verified current state (pre-Slice-2)

- `FeedDefinition` had no `virtual` field — `packages/connector-sdk/src/connector-types.ts`.
- Connector live-read method already exists — `ConnectorRuntime.query(ctx: QueryContext)`
  (`connector-runtime.ts`), lowered from `defineConnector({ query })` (`define-connector.ts`).
- `QueryContext.feedKey` is documented "present for a virtual-feed read" — `connector-types.ts`.
- Server pushdown stub existed: `connector-pushdown.ts` ran `runConnectorQuery` for
  `query_sql({ connection })` and carried a "(later) by virtual-feed reads" TODO — that
  "later" is implemented here.
- The postgres connector already had a hardened live `query()` with
  `validateReadOnlySelect` / `guardDbHost` / `setReadOnly` / `POOL_OPTS`
  (`packages/connectors/src/postgres.ts`). Slice 2 reuses every one of those guards for
  `search()`.
- Feed scheduler: `packages/server/src/scheduled/check-due-feeds.ts` selects due feeds
  by `next_run_at <= now()`.

## What was built

1. **Declaration** — `virtual?: boolean` on `FeedDefinition` (`connector-types.ts`),
   carried through `buildDefinition` in `define-connector.ts`. When true the feed is read
   live and never synced; its sync-lifecycle columns stay NULL.

2. **Persistence / migration** — `feeds.virtual boolean NOT NULL DEFAULT false`
   (`db/migrations/20260626000000_feeds_virtual_flag.sql`). Additive constant-default →
   no table rewrite, squawk-clean (`squawk-cli@2.58.0` reports 0 issues). A user-configured
   virtual feed = a `feeds` row with `virtual = true` and NULL sync-lifecycle columns.

3. **Scheduler skip** — `AND f.virtual IS NOT TRUE` added to the `check-due-feeds`
   due-selection query. A virtual feed is never picked for `sync()`, even with a past
   `next_run_at`. (E2E proves: with the guard "Found 1 due feeds"; without it "Found 2".)

4. **Connector `search()` capability** — a NEW optional `ConnectorRuntime.search(ctx:
   SearchContext): Promise<QueryResult>` (default throws "recall over virtual unsupported").
   `SearchContext extends QueryContext` + `terms: string[]`. Lowered from
   `defineConnector({ search })`. Wired through the executor as a `search` job/result mode
   (`packages/connector-worker/src/executor/interface.ts` + `child-runner.ts`).
   Implemented for postgres: probes output columns (LIMIT 0), then for each term ORs an
   `ILIKE` across every column cast to text; terms AND together (a row matches when every
   term hits ≥1 column). Terms are bound params and wildcard-escaped; runs inside the SAME
   read-only transaction + egress guard as `query()`, with a bounded LIMIT.

5. **`readVirtualFeed` pushdown seam** — implemented the "(later) virtual-feed reads" path
   in `connector-pushdown.ts`. **This is the stable export Stream A consumes.** It resolves
   the feed + backing connection under the AuthzScope visibility compiler, asserts the feed
   is virtual, reads its `config.query`, then runs `search()` (when terms present) or
   `query()` in the connector subprocess. Persists nothing.

6. **Authz / egress** — feed resolution goes through `compileConnectionRowVisibility` from
   `packages/server/src/authz/connection-visibility.ts` (the same seam `query_sql` /
   recall use), keyed on an `AuthzScope`. A member is fenced from another user's private
   virtual feed exactly as on the SQL seam. The postgres read stays inside the read-only
   transaction + `LOBU_DB_EGRESS_POLICY` guard (`block-private` under cloud mode).

### The integration seam (import this from search.ts)

```ts
import { readVirtualFeed } from '../lib/connector-pushdown';
// or, with types:
import {
  readVirtualFeed,
  type ReadVirtualFeedParams,
  type ReadVirtualFeedResult,
} from '../lib/connector-pushdown';

export interface ReadVirtualFeedParams {
  scope: AuthzScope;            // organizationId + principal; the visibility fence
  feedId: number;              // a feeds.id with virtual = true
  terms?: string[];            // present ⇒ search() (recall); absent ⇒ query() (plain live read)
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}
export interface ReadVirtualFeedResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}
export function readVirtualFeed(p: ReadVirtualFeedParams): Promise<ReadVirtualFeedResult>;
```

Errors thrown (surface, don't branch on them): `not found or not accessible` (missing /
fenced), `is not a virtual feed` (a non-virtual row), `has no \`query\` in its config`,
and the connector capability errors (`does not support recall over virtual feeds` /
`does not support live queries`).

## Open decisions (chosen)

- **`search()` as a NEW optional method** (chosen) vs a `QueryContext.search` predicate.
  Rationale: a missing method cleanly signals "recall over virtual unsupported" as a
  capability gap — no runtime branch on a flag, and `query()` (plain live read) stays
  independent of recall. Documented at the `ConnectorRuntime.search` definition.
- **feeds-row for virtual feeds** (chosen) vs rowless. A user-configured virtual feed is a
  real `feeds` row (`virtual = true`) so it carries its own config, visibility (via its
  connection), and identity — and Stream A's enumeration finds it like any other feed.
- **Recall push-down (ILIKE at source)** (chosen) vs pull-bounded-then-filter. The terms
  are translated to a source-side predicate so recall is computed where the data lives,
  inside the read-only transaction, with a bounded LIMIT — never pulling the whole feed.

## Multi-replica correctness

A virtual read is a pure per-request read: all state in Postgres, no pod-local state, the
connector subprocess opens its own socket behind the worker egress controls. Runnable on
any replica; nothing to fan out. The scheduler skip is a pure SQL predicate.

## E2E (hard gate)

`packages/server/src/__tests__/integration/connectors/virtual-feed-read.test.ts` — drives
the real chain (resolve → compile bundled postgres connector → fork subprocess → live DB),
the "external" DB pointing back at the test DB:

- (a) scheduler skips the virtual feed but selects the non-virtual control (red→green:
  guard present ⇒ "Found 1 due feeds"; guard removed ⇒ "Found 2" and the test fails);
- (b) `readVirtualFeed` returns live rows via `query()` and via `search(['ap'])`
  (ILIKE pushdown, `total` reflects the filtered count), with `events` count staying 0;
- (c) a member is fenced from the owner's PRIVATE virtual feed (`not found or not
  accessible`); the owner still reads it;
- a non-virtual feed is refused (`not a virtual feed`).

Run: from `packages/server`,
`DATABASE_URL=… PGSSLMODE=disable npx vitest run src/__tests__/integration/connectors/virtual-feed-read.test.ts`.

## Files touched

- `packages/connector-sdk/src/connector-types.ts` — `FeedDefinition.virtual`, `SearchContext`.
- `packages/connector-sdk/src/connector-runtime.ts` — `ConnectorRuntime.search()` default.
- `packages/connector-sdk/src/define-connector.ts` — lower `search`, carry `virtual`.
- `packages/connector-sdk/src/index.ts` — export `SearchContext`.
- `packages/connector-worker/src/executor/interface.ts` — `search` job + result mode.
- `packages/connector-worker/src/executor/child-runner.ts` — dispatch `search`.
- `packages/connectors/src/postgres.ts` — `search()` ILIKE pushdown.
- `packages/server/src/scheduled/check-due-feeds.ts` — `AND f.virtual IS NOT TRUE`.
- `packages/server/src/lib/connector-pushdown.ts` — `readVirtualFeed` seam.
- `db/migrations/20260626000000_feeds_virtual_flag.sql` — `feeds.virtual` column.
- `packages/server/src/__tests__/integration/connectors/virtual-feed-read.test.ts` — E2E.
