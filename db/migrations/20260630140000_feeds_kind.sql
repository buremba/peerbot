-- migrate:up

-- feeds.kind — how a feed's rows arrive. Generalizes the existing `virtual`
-- boolean into a 3-value kind so streaming sources (chat channels) can become
-- feeds without a fourth special path.
--   collected — pulled on a schedule (the default; a webhook trigger/store just
--               augments a collected feed, it is not a separate kind)
--   virtual   — read LIVE at request time via connector query()/search(),
--               never synced (today's `virtual = true`)
--   streaming — pushed in real time, never polled (chat channels; the new value)
--
-- `virtual` stays readable until the call sites (`check-due-feeds`,
-- `connector-pushdown`) move to `kind`; the boolean is dropped in a later
-- contract migration (two-phase, like the `QUERYABLE_SCHEMA` column drops).
--
-- TWO-PHASE INVARIANT (until those readers move to `kind`): a writer that
-- creates a virtual/streaming feed MUST keep `virtual` consistent
-- (`virtual = (kind = 'virtual')`) and leave the sync-lifecycle columns
-- (`schedule` / `next_run_at` / `checkpoint`) NULL for virtual+streaming, so the
-- scheduler (which still gates on `f.virtual` + a non-null `next_run_at`) never
-- queues a non-collected feed.
--
-- Additive text column with a constant default → PG11+ fills it as metadata with
-- no table rewrite; the ALTER steps take only brief table locks (no long scan
-- lock — the validate uses SHARE UPDATE EXCLUSIVE). Mirrors `feeds.virtual`.
ALTER TABLE public.feeds
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'collected';

-- Backfill from the existing flag. New column ⇒ every row starts 'collected';
-- only the virtual feeds need correcting.
UPDATE public.feeds SET kind = 'virtual' WHERE virtual IS TRUE AND kind <> 'virtual';

COMMENT ON COLUMN public.feeds.kind IS
    'How the feed''s rows arrive: collected (scheduled pull, default), virtual (live read at request time, never synced), or streaming (pushed in real time, never polled). Generalizes the virtual boolean.';

-- Bound to the enum values. DROP-IF-EXISTS keeps the ADD re-runnable; NOT VALID
-- + VALIDATE keeps it lock-safe (the add takes no scan-lock, the validate takes
-- only SHARE UPDATE EXCLUSIVE).
ALTER TABLE public.feeds DROP CONSTRAINT IF EXISTS feeds_kind_check;
ALTER TABLE public.feeds
    ADD CONSTRAINT feeds_kind_check CHECK (kind IN ('collected', 'streaming', 'virtual')) NOT VALID;
ALTER TABLE public.feeds VALIDATE CONSTRAINT feeds_kind_check;

-- migrate:down

ALTER TABLE public.feeds DROP CONSTRAINT IF EXISTS feeds_kind_check;
ALTER TABLE public.feeds DROP COLUMN IF EXISTS kind;
