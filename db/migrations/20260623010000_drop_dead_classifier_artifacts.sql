-- migrate:up

-- Post-consolidation cleanup (stacked on the P4 classifier collapse):
--   1. latest_event_classifications — a DEAD denormalized cache: no writer, no trigger, 0 rows
--      (verified). Its 4 readers are removed/repointed in this same PR (the 2 display LEFT JOINs are
--      dropped — the `classifications` field was always empty; the 2 source-filter reads repoint to
--      event_classifications and are inert anyway, since `classification_source` is rejected upstream).
--   2. classify_facet.preferred_model — ZERO code references; a planned-but-never-wired column.

-- squawk-ignore ban-drop-table -- dead table, never populated; all readers handled in this PR
DROP TABLE IF EXISTS latest_event_classifications;

ALTER TABLE classify_facet DROP COLUMN IF EXISTS preferred_model;

-- migrate:down

-- Best-effort restore (the table was never populated, so an empty recreate is faithful).
CREATE TABLE IF NOT EXISTS latest_event_classifications (
  -- squawk-ignore prefer-bigint-over-int -- restore of a dropped table; no lock concern
  event_id bigint NOT NULL,
  classifier_id bigint NOT NULL,
  id bigint NOT NULL,
  classifier_version_id bigint,
  watcher_id bigint,
  window_id bigint,
  "values" text[] NOT NULL,
  confidences jsonb DEFAULT '{}'::jsonb NOT NULL,
  source text NOT NULL,
  is_manual boolean DEFAULT false NOT NULL,
  reasoning text,
  created_at timestamptz NOT NULL,
  CONSTRAINT latest_event_classifications_pkey PRIMARY KEY (event_id, classifier_id)
);

ALTER TABLE classify_facet ADD COLUMN IF NOT EXISTS preferred_model text;
