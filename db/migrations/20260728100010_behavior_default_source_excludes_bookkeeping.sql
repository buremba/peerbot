-- Rewrite the persisted Behavior default source to exclude bookkeeping rows.
--
-- Behaviors authored with no sources persist a default all-events source
-- (`SELECT * FROM events ORDER BY occurred_at DESC`). Server bookkeeping rows
-- (`semantic_type` 'change' — config/lifecycle/entity audit trails — and
-- 'audit' — the tool-invocation log) were historically invisible to Behavior
-- windows only because they were inserted with occurred_at NULL; now that
-- insertEvent stamps occurred_at, an unchanged default source would let a
-- Behavior's own creation bookkeeping defeat skip_if_unchanged and would turn
-- every config edit into "new workspace content". New Behaviors persist the
-- excluding query (DEFAULT_BEHAVIOR_SOURCE_QUERY); this rewrites EXISTING
-- rows, matched by the exact legacy literal so explicitly authored sources are
-- never touched.

-- migrate:up
UPDATE public.watchers
   SET sources = (
     SELECT jsonb_agg(
       CASE
         WHEN elem->>'query' = 'SELECT * FROM events ORDER BY occurred_at DESC'
         THEN jsonb_set(
           elem,
           '{query}',
           to_jsonb('SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC'::text)
         )
         ELSE elem
       END
     )
     FROM jsonb_array_elements(sources) AS elem
   )
 WHERE sources @> '[{"query": "SELECT * FROM events ORDER BY occurred_at DESC"}]'::jsonb;

UPDATE public.watcher_versions
   SET version_sources = (
     SELECT jsonb_agg(
       CASE
         WHEN elem->>'query' = 'SELECT * FROM events ORDER BY occurred_at DESC'
         THEN jsonb_set(
           elem,
           '{query}',
           to_jsonb('SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC'::text)
         )
         ELSE elem
       END
     )
     FROM jsonb_array_elements(version_sources) AS elem
   )
 WHERE version_sources @> '[{"query": "SELECT * FROM events ORDER BY occurred_at DESC"}]'::jsonb;

-- migrate:down
UPDATE public.watchers
   SET sources = (
     SELECT jsonb_agg(
       CASE
         WHEN elem->>'query' = 'SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC'
         THEN jsonb_set(elem, '{query}', to_jsonb('SELECT * FROM events ORDER BY occurred_at DESC'::text))
         ELSE elem
       END
     )
     FROM jsonb_array_elements(sources) AS elem
   )
 WHERE sources @> '[{"query": "SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC"}]'::jsonb;

UPDATE public.watcher_versions
   SET version_sources = (
     SELECT jsonb_agg(
       CASE
         WHEN elem->>'query' = 'SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC'
         THEN jsonb_set(elem, '{query}', to_jsonb('SELECT * FROM events ORDER BY occurred_at DESC'::text))
         ELSE elem
       END
     )
     FROM jsonb_array_elements(version_sources) AS elem
   )
 WHERE version_sources @> '[{"query": "SELECT * FROM events WHERE semantic_type NOT IN (''change'', ''audit'') ORDER BY occurred_at DESC"}]'::jsonb;
