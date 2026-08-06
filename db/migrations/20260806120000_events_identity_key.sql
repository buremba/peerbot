-- migrate:up

-- Stable THING-identity for event rows (schema only).
--
-- `events.id` is a stored-VERSION id: every supersede mints a new one. So it
-- cannot answer "which live row is the current version of this thing?", which
-- is exactly what a keyed Behavior output has to ask on every run. Nothing else
-- on the row can answer it either:
--
--   * origin_id is scoped per CONNECTION (idx_events_connection_origin_id) and
--     that scope is erasable — events_connection_id_fkey is ON DELETE SET NULL,
--     so deleting a connection nulls connection_id on its entire history. Prod
--     carries 53,093 live rows in that state, sharing origin_ids with nothing
--     to disambiguate them and zero supersedes ever recorded.
--   * metadata->>'_lobu_idempotency_key' is unique over ALL rows (that is the
--     guarantee) where identity must be unique over LIVE rows only, and its
--     value must DIFFER per write where identity must be IDENTICAL across
--     versions. One column cannot hold both.
--   * an expression index over the declared metadata fields — the shape
--     idx_canvas_chain_root uses — works only because canvas_state's key fields
--     are static. Keyed outputs declare theirs at runtime, per Behavior.
--
-- Uniqueness is declared PER NAMESPACE (one partial index per namespace that
-- claims it) rather than as one blanket index. entity_identities took the
-- blanket route and its per-namespace `uniquePerOrg` knob has sat with zero
-- consumers ever since, unable to express that email_domain is not unique.
--
-- Adoption of pre-existing rows is deliberately NOT done here. The key is
-- computed by computeStableKey()/formatBehaviorEventIdentity() in
-- packages/server/src/utils/stable-keys.ts, and mirroring that encoding in SQL
-- would mean two implementations of one algorithm kept in step by a test —
-- where any drift silently stamps keys no run can probe for. Instead
-- scripts/backfill-event-identity.ts stamps existing rows out of band using the
-- real function. See docs/MIGRATIONS.md for the out-of-band backfill pattern.

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS identity_ns  text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS identity_key text;

COMMENT ON COLUMN public.events.identity_ns IS
    'Identity namespace of the writer that claims this row has a stable cross-version identity (e.g. behavior_event). NULL for one-shot events, which have no "current version".';
COMMENT ON COLUMN public.events.identity_key IS
    'Stable identity of the THING this row is a version of, within identity_ns. Server-derived (stable-keys.ts), never model-authored. Set together with identity_ns or not at all.';

-- NOT VALID keeps the ALTER off a full-table scan under lock. The VALIDATE
-- lives in its own migration (20260806120030): in THIS transaction the ADD
-- CONSTRAINT's ACCESS EXCLUSIVE lock is held until COMMIT, so a same-migration
-- VALIDATE would run its full heap scan while still holding AEL on events —
-- the exact stall NOT VALID exists to avoid. In a separate transaction it
-- takes only SHARE UPDATE EXCLUSIVE and writes proceed. NOT VALID already
-- checks every new INSERT and UPDATE; only pre-existing rows go unproven
-- until then.
ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_identity_pair;

ALTER TABLE public.events
    ADD CONSTRAINT events_identity_pair
    CHECK ((identity_ns IS NULL) = (identity_key IS NULL)) NOT VALID;

-- Expose the identity through current_event_records, the live-event view that
-- query_sql/validateAndScopeQuery read (execute-data-sources.ts). The view's
-- column list is hand-maintained by each migration that adds an events column;
-- without the pair here a query_sql SELECT of identity_* against a live event
-- fails with "column does not exist" even though the raw table has them.
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
    e.linked_org_ids,
    e.identity_ns,
    e.identity_key
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
    e.supersedes_event_id,
    e.linked_org_ids
   FROM public.events e
  WHERE e.superseded_by IS NULL;

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_identity_pair;
ALTER TABLE public.events DROP COLUMN IF EXISTS identity_key;
ALTER TABLE public.events DROP COLUMN IF EXISTS identity_ns;
