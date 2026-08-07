-- Which Behavior produced this event, and which version of it (lobu#2588).
--
-- `events` had no Behavior column: the only links were `run_id` (two hops via
-- `runs.watcher_id`) and an unindexed `metadata->>'behavior_id'` that only some
-- writers stamped. So "what did this Behavior produce" was unanswerable without
-- joining run history — the Behavior page offered `analyzed_by_behavior_id`,
-- events the Behavior READ, in place of the ones it WROTE — and a Behavior
-- could not be excluded from its own window by provenance, leaving a future
-- `window_end` stamp as the only thing stopping it from eating its own output.
--
-- Both columns are stamped at WRITE time and read back by index. `ON DELETE SET
-- NULL` matches the existing `run_id` / `connection_id` FKs; it cannot break
-- output identity the way a nulled `connection_id` once broke dedup, because a
-- behavior output's identity lives in its `origin_id`.
--
-- Schema only. Backfill is 20260807130010, index 20260807130020: the ADD COLUMN
-- below holds ACCESS EXCLUSIVE on `events` until this transaction commits, so
-- folding in a 2.84M-row scan would hold AEL on the hottest table throughout.

-- migrate:up

ALTER TABLE public.events
  -- squawk-ignore prefer-bigint-over-int -- matches the integer watchers PK it references
  ADD COLUMN IF NOT EXISTS behavior_id integer,
  -- squawk-ignore prefer-bigint-over-int -- matches the integer watcher_versions PK it references
  ADD COLUMN IF NOT EXISTS behavior_version_id integer;

-- NOT VALID so the ADD does not scan the table under lock; the VALIDATE runs in
-- 20260807130010, after the backfill and in its own transaction (SHARE UPDATE
-- EXCLUSIVE — reads and writes proceed). NOT VALID still checks every new INSERT
-- and UPDATE, including the backfill's, so nothing lands unverified.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_behavior_id_fkey;

ALTER TABLE public.events
  ADD CONSTRAINT events_behavior_id_fkey
  FOREIGN KEY (behavior_id) REFERENCES public.watchers(id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_behavior_version_id_fkey;

ALTER TABLE public.events
  ADD CONSTRAINT events_behavior_version_id_fkey
  FOREIGN KEY (behavior_version_id) REFERENCES public.watcher_versions(id) ON DELETE SET NULL
  NOT VALID;

COMMENT ON COLUMN public.events.behavior_id IS
    'The Behavior that PRODUCED this row (outputs, entity change sets, canvas revisions, notifications). Never set for events a Behavior merely READ — that is watcher_window_events — and never for human-authored corrections about a Behavior. Drives produced_by_behavior_id and the window self-exclusion.';
COMMENT ON COLUMN public.events.behavior_version_id IS
    'The Behavior version that produced this row, so output quality can be attributed to a prompt version. Provenance only; not indexed on its own, because a version comparison always narrows by behavior first.';

-- The live-event view every Behavior source query reads through
-- (execute-data-sources.ts builds its events CTE over this, not over `events`).
-- Its column list is hand-maintained by each migration that adds an events
-- column: without the pair here, the self-exclusion predicate fails with
-- "column ev.behavior_id does not exist" and — because a failed data source is
-- logged and returned as EMPTY rather than raised — every Behavior would
-- silently read nothing at all.
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
    e.identity_key,
    e.behavior_id,
    e.behavior_version_id
   FROM public.events e
  WHERE e.superseded_by IS NULL;

-- migrate:down
-- CREATE OR REPLACE VIEW cannot DROP a column (42P16), so the rollback drops
-- and recreates the view before the columns it references can go.
DROP VIEW public.current_event_records;
CREATE VIEW public.current_event_records AS
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

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_behavior_version_id_fkey;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_behavior_id_fkey;
ALTER TABLE public.events DROP COLUMN IF EXISTS behavior_version_id;
ALTER TABLE public.events DROP COLUMN IF EXISTS behavior_id;
