-- migrate:up

-- Slice 2 — virtual feed flag. A VIRTUAL feed is read LIVE against its source
-- at request time (connector query()/search()) and NEVER synced: no events are
-- persisted, no checkpoint is kept, and the feed scheduler (check-due-feeds)
-- skips it via `AND f.virtual IS NOT TRUE`. A user-configured virtual feed is a
-- `feeds` row with virtual=true whose sync-lifecycle columns (schedule /
-- next_run_at / checkpoint) stay NULL.
--
-- Additive boolean with a constant default → PG11+ fills it as metadata with no
-- table rewrite, so this is lock-safe at prod row counts (squawk-clean, mirrors
-- the existing `agents.show_tool_calls` add).
ALTER TABLE public.feeds
    ADD COLUMN IF NOT EXISTS virtual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.feeds.virtual IS
    'When true, the feed is read live via the connector query()/search() pushdown at request time and is never synced — the sync scheduler excludes it and its sync-lifecycle columns stay NULL.';

-- migrate:down

ALTER TABLE public.feeds DROP COLUMN IF EXISTS virtual;
