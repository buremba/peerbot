-- migrate:up

-- Per-watcher local-CLI execution settings for device-worker runs (the Mac
-- app's WatcherDispatcher spawns `claude -p`/`codex` — see
-- packages/owletto/apps/mac/Owletto/WatcherDispatcher.swift). NULL = all
-- defaults (timeout falls back to the dispatcher's 600s cap; every other
-- field is omitted from the spawn args, leaving the CLI default).
--
-- Shape: { timeout_seconds, max_budget_usd, model, permission_mode, effort }.
-- A single jsonb (mirroring watchers.model_config) so future knobs don't need
-- a migration. Validated on write by the manage_watchers TypeBox schema.
ALTER TABLE public.watchers ADD COLUMN IF NOT EXISTS execution_config jsonb;

COMMENT ON COLUMN public.watchers.execution_config IS 'Per-watcher device-worker CLI execution settings: { timeout_seconds, max_budget_usd, model, permission_mode, effort }. NULL = defaults.';

-- migrate:down

ALTER TABLE public.watchers DROP COLUMN IF EXISTS execution_config;
