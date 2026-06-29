# Feed consolidation — build plan

The **build plan** for collapsing connections, channels, webhooks, and live
datasets onto one feed model. The conceptual model (kinds × lenses, the
`FeedReader` target) is in [`feeds-and-connections-model.md`](./feeds-and-connections-model.md) —
that doc is authoritative for *what the model is*; this one is *how we get there*.

## Decisions locked

- **Connection is the hub.** One `connections` table; capabilities are derived
  facets (data / chat / actions / audience), not types. *(shipped — Stage 2b)*
- **Feed is the one data-in abstraction.** A channel is a streaming feed; a
  webhook is a streaming feed; a repo sync is a collected feed; a live query is
  a virtual feed. No separate "channel" concept.
- **Capture ≠ knowledge — keep both stores.** `channel_messages` (cheap, high-
  volume transcript, un-embedded) stays separate from `events` (curated,
  embedded, ACL'd). Forcing chat through the embed pipeline is the congestion
  path we've already hit. The store a feed writes is a property of the
  **adapter**, not of `kind`.
- **Promotion is the one new primitive.** "This captured row matters → make it a
  curated event" — one path replacing `save_knowledge` / the webhook
  `searchable` flag / watcher writes.
- **Agent = composition** (model + skills + guardrails + connections + memory);
  **skills** are the capability unit. **Watcher and Agent stay distinct** (not
  collapsed). **Connector ≠ Provider** (inference is not data/actions).

## The `kind` is already half-there

`feeds.virtual` (migration `20260626000001`) is a **wired** flag, not inert:
`check-due-feeds.ts` skips virtual feeds from sync; `connector-pushdown.ts`
branches `virtual=true` → live read. So today we already have a two-value kind:
`collected` (false) vs `virtual` (true). The SDK declares it
(`FeedDefinition.virtual` + `ConnectorRuntime.query()`/`search()`). The **only
missing value is `streaming`** — and it only matters once streaming sources are
feed rows. So generalizing the boolean → `kind` enum lands *with* streaming, not
as a standalone step.

## Gaps — resolved into the model

1. **ACL / Audience.** Split cleanly: *ingestion* is just a **collected feed**
   that syncs `conversations.members` / collaborators into the access graph
   (`authz_source_acl_state`); *enforcement* is a **mandatory access-graph filter
   on every reader** in the registry. A generic reader that drops the filter
   leaks across users — so the gate is a first-class reader input, designed in,
   not bolted on.
2. **Connector declarations.** SDK has `virtual` + `collected` + the live-read
   handlers. Missing: a **streaming** feed declaration, a **push-handler** hook
   on `ConnectorRuntime`, a **backfill-capable** flag + handler, and an explicit
   **store** target (events vs channel_messages). This is the phase-1 SDK work.
   (Don't conflate with the connector-level `kind: 'data' | 'integration'` — a
   different axis.)
3. **Streaming-feed lifecycle.** A channel-feed exists **iff the bot is in the
   channel** — `conversations.list` enumerates them; a join creates the feed, a
   leave retires it. No separate link step.
4. **Constraints (honored, not new builds):** streaming runtime + checkpoints
   must be multi-replica-safe (Postgres-mediated, no in-memory cross-pod state);
   backfill must be throttled so promoting channel history doesn't re-trigger the
   embed-congestion collapse.

## Phases

Most of this is **folding existing code under one seam**, not new construction.

1. **Streaming as feeds** (carries the `kind` enum). Model channels (per-channel,
   bot-membership lifecycle) + webhooks as `feeds` rows; generalize
   `feeds.virtual` → `kind` (collected | streaming | virtual), backfilled from the
   boolean; routing (binding) + store pointer become per-feed metadata. SDK gains
   the streaming declaration + push hook + store target.
   *Reuses:* feeds table, bindings, `channel-transcript.ts`, `webhook-ingest.ts`.
2. **Reader registry.** Generalize `search.ts`'s `RecallSource[]` → one registry
   keyed by lens (store-read vs live-pushdown); fold metric + virtual under it.
   The **access-graph filter is a required argument** (gap 1 enforcement).
   *Reuses:* `search.ts`, `query_metric`, `query_sql`, connector `query()`.
   *Parallel to phase 1.*
3. **Unified Feeds UI + backfill.** One kind-aware Feeds section per connection
   (reuse the Stage-2b `ConnectionSourceRow`); a Backfill control on backfill-
   capable streaming feeds; retire the deferred Channels surface.
   *Needs phase 1.*
4. **Promotion primitive.** One "promote captured → knowledge" path replacing the
   three ad-hoc bridges. The genuinely new verb; lands independently after 2.
5. **Agent composition + tool plane** (UI-led). Recompose the agent page as
   model + skills + guardrails + connections + memory; unify the three tool
   sources (built-ins / connector-actions / skill-MCP) into one registry behind
   the MCP proxy. Mostly framing; independent.

**Sequence:** `1 ∥ 2 → 3`, then `4` and `5` slot in anytime.

## Risk

Concentrated in the three genuinely-new builds: **streaming-as-feeds modeling**
(phase 1), **per-channel backfill** (phase 3), and the **promotion verb**
(phase 4). The ACL-filter-as-required-reader-input (phase 2) is the correctness
gate — easiest thing to break silently during the read consolidation. Everything
else is consolidation of code that already works.

## Stage 2b (the foundation) — landed

The connection hub shipped: owletto#384 (`8da6bad`) + lobu#1608 (`49ae44545`) —
one connection table, derived facets, per-connector index, managed revoke. The
Channels/Reach UI was deliberately trimmed out and returns in phase 3 as the
unified Feeds section.
