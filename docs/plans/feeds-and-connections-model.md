# Feeds & Connections — the queryable-source model

**Status: PARTLY BUILT.** All three feed kinds already exist in some form (see
the table). The `recall` lens now dispatches every source (`knowledge` = events,
`conversation` = channel_messages, `virtual` = live virtual feeds) through the
tuple-shaped `FeedReader<S, L>` registry (`RECALL_SOURCES` in
`packages/server/src/tools/search.ts`, reader contract in
`packages/server/src/lib/feed-reader.ts`) — parameterized by `(sourceKind,
lensKind)`, gated by `canRead`, no central `switch`. What is **not** yet built is
folding the OTHER lenses (metric / raw-sql) and the live-pushdown path into that
same registry — today they live in separate code paths. Reviewed with an external
model (Q: collapse the axes? → "keep them orthogonal").

**Related docs (authoritative for the kinds/lenses below):**
[`docs/database-connectors.md`](../database-connectors.md) — the PostgreSQL
connector, live-read `query()`, connection-backed entities, and the `virtual`
feed-flag roadmap. [`docs/define-metric-design.md`](../define-metric-design.md) —
the entity-bound metric lens. This doc is the *cross-cutting* model that ties the
feed kinds and read lenses together; those two are the per-area sources of truth.

## Mental model

A **connection** is a *queryable source* (Postgres-like). A **feed** is a *view*
over it, **generated on the fly** at access time. Materialization — writing rows
into `events`, caching into `metric_series` — is an **optimization, not the
model**. A feed is fundamentally a generated query, some of which happen to be
materialized.

## Two orthogonal axes (do NOT collapse into one enum)

A feed is described by two independent dimensions. Flattening them into a single
`chat-recall / live-dataset-metric / …` taxonomy is an oversimplification:
combinatorial growth, awkward capability gaps, worse type evolution. "Where the
bytes live" and "how the caller wants to read them" are different concerns.

### Axis 1 — Source kind (where the data lives)

| kind | backing | status |
| --- | --- | --- |
| `chat-channel` | local transcript table `channel_messages` (live conversation) | exists |
| `virtual-live-dataset` | external source queried **live**, nothing copied locally — PostgreSQL connector (`packages/connectors/src/postgres.ts`) `query()` live-read + `search()` recall pushdown. User-configured live feeds are `feeds.kind = 'virtual'` (`virtual` boolean retained as a transitional compatibility flag). | exists |
| `collected` | sync materializes rows into `events` (the classic data feed = real row in `feeds`) | exists |

### Axis 2 — Read lens (how you query)

| lens | mechanism | status |
| --- | --- | --- |
| `recall` | fuzzy / semantic retrieval — `search_memory` | **shipped** |
| `metric` | aggregation — `query_metric` → materialized `metric_series` (see `define-metric-design.md`) | exists |
| `raw-sql` | scoped SQL — `QUERYABLE_SCHEMA` → `buildScopedQuery` CTEs (`query_sql`) | exists |

Any lens over any kind. Source kind = where bytes live; lens = read semantics.

## The unifying abstraction (realized for recall)

One concept — *a generated query/view parameterized by (source, shape) + lens* —
realized as a **capability registry keyed by the `(sourceKind, lensKind)`
tuple**. Not inheritance, not a central `switch`. The reader contract lives in
`packages/server/src/lib/feed-reader.ts`:

```ts
type SourceKind = 'chat-channel' | 'virtual-live-dataset' | 'collected';
type LensKind   = 'recall' | 'metric' | 'raw-sql';

interface FeedReader<S extends SourceKind, L extends LensKind, Ctx, Out> {
  readonly source: S;
  readonly lens: L;
  canRead(ctx: Ctx): boolean;                // decline a ctx you can't serve
  read(gate: AuthzScope, ctx: Ctx): Promise<Out>;
}
```

- Register concrete `(source, lens)` handlers; dispatch by tuple key.
- **Missing combinations are explicit unsupported capabilities, not enum holes.**
- `canRead` lets a reader opt out of a ctx (no query text, wrong signal) so the
  registry skips it **branch-free** — the guard is on the reader, not a
  caller-side `if`.
- The ACL gate (`AuthzScope`) is a required, typed first argument of `read`,
  threaded by the registry so a call site cannot drop it.
- Materialization is an implementation detail of the *source adapter*.
- Adding a new kind (live dataset) or a new lens stays branch-free.

**Realized today for `lens = recall` only** (`RECALL_SOURCES`, three sources
across all three source kinds). The metric / raw-sql lenses and the live-pushdown
path have not yet been folded under this registry — see below.

## What's shipped today — the recall slice

`search.ts` holds a `RecallSource[]` registry: the `lens = recall` row of the
matrix, varying source. Each entry is a `FeedReader<SourceKind, 'recall', …>`.

- `knowledge` source (`collected`) → `events` (semantic + keyword,
  visibility-scoped).
- `conversation` source (`chat-channel`) → `channel_messages` (keyword +
  recency, **fenced to the calling agent's bound channels**; all-stop-word
  prompts fall back to recency).
- `virtual` source (`virtual-live-dataset`) → opt-in virtual feeds read LIVE via
  `readVirtualFeed` (`config.recall === true`, capped fan-out, connection-visibility
  gated).

`gatherRecall` filters by `canRead(ctx)` then runs every remaining source and
merges their result facets — no central `if/else`, each source contributes only
its facet, failures are isolated. This is exactly the `FeedReader[]` registry
restricted to one lens.

`get_channel_history` was **retired** in favour of this: past channel
conversation is read through `search_memory` (returns `conversation_messages`
alongside `content`), the same path as all other memory. `read_conversation`
remains the point-read of a single named conversation.

## Why the metric / raw-sql fold is still deferred

The recall lens is now on the `FeedReader<S,L>` tuple registry. The other two
lenses are not: metric runs via the connector `query()` / `metric_series` path,
`query_sql` via `QUERYABLE_SCHEMA` → `buildScopedQuery` CTEs (plus its own
virtual-feed / connector-query branches). Folding them under the SAME
tuple-dispatched registry is a **consolidation of existing capability, not a new
one** — pure refactor across two working subsystems, with no behavior change and
real regression surface. It is deferred until a concrete second-lens need forces
it (e.g. a new lens that must share the source-adapter layer), per the "design
the seam, not the framework" discipline. The recall registry was shaped as the
tuple `(source, lens)` precisely so that fold is additive when it lands: a metric
reader is just another `FeedReader<S, 'metric', …>` registered by tuple key.

`query_sql` coverage hints do **not** mean the raw-sql lens now federates virtual
feeds. They are advisory metadata: an `events` SQL result can say "these live
virtual feeds are accessible but missing from persisted events" and provide a
`client.feeds.readMany` example. The live reads still happen explicitly through
feed addressing or the batch feed-read API.
