# Feeds & Connections — the queryable-source model

**Status: DESIGN.** Shipped today is only the `recall` lens over two stores
(`events` + `channel_messages`) via the `RecallSource[]` registry in
`packages/server/src/tools/search.ts`. Everything else here — the
`virtual-live-dataset` kind, the `FeedReader` generalization — is the agreed
target, not built. Reviewed with an external model (Q: collapse the axes? →
"keep them orthogonal").

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
| `virtual-live-dataset` | external source queried **live** (e.g. a Postgres connector); nothing copied locally | design |
| `collected` | sync materializes rows into `events` (the classic data feed = real row in `feeds`) | exists |

### Axis 2 — Read lens (how you query)

| lens | mechanism | status |
| --- | --- | --- |
| `recall` | fuzzy / semantic retrieval — `search_memory` | **shipped** |
| `metric` | aggregation — `query_metric` → materialized `metric_series` | exists |
| `raw-sql` | scoped SQL — `QUERYABLE_SCHEMA` → `buildScopedQuery` CTEs (`query_sql`) | exists |

Any lens over any kind. Source kind = where bytes live; lens = read semantics.

## The unifying abstraction (target)

One concept — *a generated query/view parameterized by (source, shape) + lens* —
realized as a **capability registry keyed by the `(sourceKind, lensKind)`
tuple**. Not inheritance, not a central `switch`.

```ts
type SourceKind = 'chat-channel' | 'virtual-live-dataset' | 'collected';
type LensKind   = 'recall' | 'metric' | 'raw-sql';

interface FeedReader<S extends SourceKind, L extends LensKind> {
  readonly source: S;
  readonly lens: L;
  canRead(feed: FeedSpec<S, L>): boolean;
  read(ctx: ReadCtx, feed: FeedSpec<S, L>): Promise<ResultFor<L>>;
}
```

- Register concrete `(source, lens)` handlers; dispatch by tuple key.
- **Missing combinations are explicit unsupported capabilities, not enum holes.**
- Materialization is an implementation detail of the *source adapter*.
- Adding a new kind (live dataset) or a new lens stays branch-free.

## What's shipped today — the recall slice

`search.ts` holds a `RecallSource[]` registry: the `lens = recall` row of the
matrix, varying source.

- `knowledge` source → `events` (semantic + keyword, visibility-scoped).
- `conversation` source → `channel_messages` (keyword + recency, **fenced to the
  calling agent's bound channels**; all-stop-word prompts fall back to recency).

`gatherRecall` runs every source and merges their result facets — no central
`if/else`, each source contributes only its facet, failures are isolated. This
is exactly the `FeedReader[]` shape restricted to one lens.

`get_channel_history` was **retired** in favour of this: past channel
conversation is read through `search_memory` (returns `conversation_messages`
alongside `content`), the same path as all other memory. `read_conversation`
remains the point-read of a single named conversation.

## Why not generalize to `FeedReader<S,L>` now

Only the `recall` lens has multiple sources today; `metric` and `raw-sql` are
separate existing paths, and the `virtual-live-dataset` kind does not exist.
Generalizing now is building ahead of need. Promote `RecallSource` →
`FeedReader` when a 3rd source kind or a second lens genuinely needs to share the
registry — the current shape was chosen so that promotion is additive.
