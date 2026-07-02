-- migrate:up

-- Flip the masking view from the per-row anti-join
--   WHERE NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id)
-- to the denormalized predicate backed by idx_events_live_org_created. Every
-- live-row read stops scanning the ~75% superseded tombstones.
--
-- Correctness contract (why this is safe NOW and wasn't in Stage 1):
--   - New superseding writes stamp `superseded_by` in the SAME transaction as
--     the superseding INSERT (insert-event.ts, since 20260702200000).
--   - Historical rows were filled by 20260702300000 (and prod out of band
--     beforehand), so no committed superseded row has a NULL edge.
--   - The partial unique index idx_events_superseded_by still guarantees at
--     most one superseder, so the edge can never be ambiguous.
--
-- Column list MUST stay identical to the previous definition — the one from
-- 20260618140000_event_embeddings_contract.sql, which DROPPED the
-- event_embeddings join (vector callers read event_embeddings directly). Only
-- the WHERE clause changes, so CREATE OR REPLACE VIEW is valid.
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
  WHERE NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE newer.supersedes_event_id = e.id));
