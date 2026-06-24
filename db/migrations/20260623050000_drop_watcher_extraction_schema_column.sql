-- migrate:up

-- Inline watcher extraction_schema is gone. The output contract is now derived
-- at runtime: an entity-typed watcher (keying_config.entity_type) derives it from
-- that entity type's metadata_schema (packages/server/src/utils/watcher-extraction-
-- schema.ts); an untyped watcher runs the worker's free-form {summary} fallback.
-- There is no third path with an inline schema.
--
-- The authoring surface (manage_watchers tool input, SDK namespace, CLI, UI) was
-- removed in the same change, so this column has received only NULL since. The
-- two runtime sites that used to fall back to it
-- (worker-api/poll.ts, manage_watchers/complete-window.ts) now resolve via
-- deriveWatcherExtractionSchema only, and every display read was dropped. Nothing
-- reads the column — drop it.
--
-- Data note: any pre-existing watcher_versions row that carried a non-NULL inline
-- schema is, after this change, treated as untyped (free-form {summary}) unless it
-- is entity-typed, in which case derive reproduces its contract from the entity
-- type. This is the intended consolidation; the column is not restored on rollback
-- (the inline values are intentionally abandoned).

ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS extraction_schema;

-- migrate:down

-- Best-effort restore: the column is recreated nullable and empty. Original inline
-- values are not recoverable (intentionally abandoned by the consolidation), so the
-- down migration only restores the shape, not the data.
ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS extraction_schema jsonb;
