-- migrate:up transaction:false

-- Stable THING-identity for event rows (schema part 2: the constraint).
-- Companion to 20260806120000, split out because CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction and db:lint (squawk) bans non-concurrent
-- builds on the hot events table. One statement per transaction:false
-- migration — dbmate sends the block as one simple-query batch and
-- CONCURRENTLY can't share it.
--
-- THIS INDEX IS THE FIX. `persistBehaviorEventOutput` resolves the current head
-- with a SELECT and INSERTs inside the caller's transaction; under READ
-- COMMITTED a second run whose probe lands before the first COMMITS sees no
-- head, so both insert with supersedes_event_id = NULL and both stay live —
-- permanently, silently, no error. idx_events_superseded_by cannot catch that
-- because it is unique on supersedes_event_id, which is NULL on both rows.
--
-- Keyed on the CHAIN ROOT (supersedes_event_id IS NULL), NOT on the live head
-- (superseded_by IS NULL) — the same shape as idx_canvas_chain_root, and for
-- the same reason. insertEvent INSERTs the successor and only then stamps the
-- predecessor's superseded_by (the dual-write in insert-event.ts), so between
-- those two statements BOTH rows are live. A live-head index would therefore reject every
-- ordinary sequential supersede, not just the concurrent duplicate. Root
-- uniqueness sidesteps that window entirely: a successor carries a non-NULL
-- supersedes_event_id and is simply not in the index.
--
-- One live head per identity then falls out of two constraints together: at
-- most one ROOT per identity (here) and at most one successor per row
-- (idx_events_superseded_by, unique on supersedes_event_id). A chain cannot
-- fork, and a second chain cannot start.
--
-- Scoped to identity_ns = 'behavior_event' so uniqueness is a per-namespace
-- claim: a namespace that wants it declares its own index, one that does not
-- simply has none. entity_identities instead enforces a single blanket index
-- across all namespaces, which is why its `uniquePerOrg` knob exists, is
-- declared false for email_domain, and has never had a consumer.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_root_behavior
  ON public.events (organization_id, identity_key)
  WHERE supersedes_event_id IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'behavior_event';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_root_behavior;
