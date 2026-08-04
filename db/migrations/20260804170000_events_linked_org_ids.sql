-- Org-scope bridge, denormalized (schema part 1: column + view).
-- The GIN index lives in 20260804170001 so it can build CONCURRENTLY —
-- CREATE INDEX CONCURRENTLY can't run inside a transaction, and db:lint
-- (squawk) bans non-concurrent index builds on the hot events table.
--
-- Org-scoped reads (content feed, derived views, data sources) must answer:
-- "is this event visible to org X?" An event is in scope when ANY of:
--   1. it was stamped to X directly (`events.organization_id`),
--   2. one of its `entity_ids` belongs to an entity of X, or
--   3. the connection that produced it belongs to X.
--
-- Branches 2+3 were evaluated as per-row OR/EXISTS subplans over the whole
-- live-events table (~422k subplan executions, ~1-2s per query on prod) and
-- defeated every index on the outer scan. This column folds branches 2+3 into
-- a single GIN-indexed array computed AT WRITE TIME (entity orgs and the
-- connection's org are immutable; events are append-only and merges never
-- rewrite them), turning the scope predicate into two indexable conditions:
--
--   organization_id = $org OR linked_org_ids @> ARRAY[$org]
--
-- Semantics are EXACTLY the old bridge: orgs of the stamped entities and of
-- the producing connection, minus the event's own org. `{}` means "no linked
-- orgs"; NULL only exists on rows predating the backfill.

-- migrate:up
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS linked_org_ids text[];

-- Recreate the live-events view to expose the column (eventOrgScope in
-- execute-data-sources.ts predicates over this view).
CREATE OR REPLACE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.search_tsv,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id,
    e.linked_org_ids
   FROM public.events e
  WHERE e.superseded_by IS NULL;

-- migrate:down
CREATE OR REPLACE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.search_tsv,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id
   FROM public.events e
  WHERE e.superseded_by IS NULL;

ALTER TABLE public.events DROP COLUMN IF EXISTS linked_org_ids;
