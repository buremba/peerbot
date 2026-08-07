-- Which Behavior produced this event, and which version of it (lobu#2588).
--
-- `events` had no Behavior column at all. The only links were `run_id`
-- (→ `runs.watcher_id`, two hops) and an unindexed `metadata->>'behavior_id'`
-- that only some writers stamped. Three things fell out of that:
--
--   * "what did this Behavior produce" was unanswerable without joining
--     run history, so the Behavior page instead offered
--     `analyzed_by_behavior_id` — events the Behavior READ (2,289 for
--     Behavior 71) in place of the ones it WROTE (354).
--   * a Behavior could not be excluded from its own window input by
--     provenance, so the only thing stopping it from eating its own output
--     was stamping that output at `window_end` — a timestamp in the future
--     for the whole day an hourly Behavior runs, which removed it from every
--     read path (`occurred_at <= now()`).
--   * output quality could not be attributed to a prompt version.
--
-- Both columns are stamped at WRITE time by the producing path and read back
-- by index; nothing here is derived per request. `ON DELETE SET NULL` matches
-- the existing `run_id` / `connection_id` / `feed_id` FKs on this table. It
-- cannot break output identity the way a nulled `connection_id` once broke
-- dedup, because a behavior output's identity lives in its `origin_id`
-- (`behavior:<id>:output:<name>:key:<hash>`), not in this column.
--
-- The backfill reads the two places the provenance already existed: the run row
-- (authoritative, and the only source of the version) and the `metadata` blob
-- stamped by `persist-behavior-event-output` and the change-set and canvas
-- writers. (`promote-keyed-entities` is NOT one of them — it upserts entities
-- and writes no event. `submit_feedback` stamps the same key on `correction`
-- rows and is skipped on purpose; see 20260807130010.)
--
-- Schema only. The backfill lives in 20260807130010 and the index in
-- 20260807130020, for the reason 20260806120000/20260806120030 split: the
-- ADD COLUMN below takes an ACCESS EXCLUSIVE lock on `events` that is held
-- until THIS transaction commits, so folding in a backfill that sequentially
-- scans 2.84M rows would hold AEL on the hottest table for the whole scan.
-- Split, this migration commits in milliseconds and the backfill runs under
-- ROW EXCLUSIVE, which blocks nothing.

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
