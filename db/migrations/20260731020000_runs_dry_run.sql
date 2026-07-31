-- `runs.dry_run` — execute a connector sync for real, persist nothing.
--
-- Why this is needed at all: `lobu connector run` only accepts `browser_session`
-- profiles, and that is not an oversight. Browser sessions are the device-pinned
-- carve-out in the credential rules (packages/server/AGENTS.md), so the CLI may
-- legitimately hold them. OAuth and API-key credentials are durable stored
-- credentials that must never leave the gateway, so a connector using them can
-- only be exercised where the credentials already live — server side. Until now
-- the only way to do that was a real sync, which really persists.
--
-- How it is enforced, and why that shape. The dry path does NOT skip the
-- writes; it runs the identical ingest code against a transaction and rolls
-- back. The set of things a dry run must not do is open-ended — it grows every
-- time anyone adds a write to the ingest path — while the set it must keep is
-- closed (the preview, and the run row's own lifecycle). Enumerating the closed
-- set and letting the transaction cover the open one means a write added later
-- is handled without its author knowing this feature exists. It also makes the
-- answer trustworthy: because the real INSERTs execute, a dry run reports a
-- constraint violation or bad cast exactly as the real path would, instead of
-- previewing rows that could never land. The only writes needing an explicit
-- guard are the ones that escape Postgres (ArtifactStore blob upload, Behavior
-- run dispatch, detached auto-linking, transcription) — a category a reviewer
-- can check mechanically rather than a list to memorize.
--
-- Why a column on `runs` rather than a parallel table or an in-memory flag:
-- the sync already IS a run, the flag has to survive the worker round-trip
-- (worker executes, POSTs batches back, the SERVER decides what to persist in
-- `worker-api/run-lifecycle.ts`), and any replica may serve that callback. An
-- in-memory map would be wrong on a second pod.
--
-- `dry_run_preview` holds what WOULD have been ingested. Deliberately capped and
-- marked `truncated` rather than unbounded: a sync can emit thousands of items,
-- and the point is to show an operator the shape of the output, not to become a
-- second copy of `events`. It lives on `runs` — not `events` — precisely because
-- `runs` is mutable working state while `events` is append-only; a preview that
-- landed in `events` could never be cleaned up.
--
-- What a dry run does NOT promise: `idx_runs_active_sync_per_feed` is a partial
-- unique index on (feed_id) for active syncs and does not distinguish dry from
-- real, so a dry run occupies the feed's one active-sync slot. A scheduled sync
-- arriving mid-dry-run is skipped for that tick (and picked up on the next one),
-- and triggering dry while a real sync is active returns "already pending or
-- running". That is deliberate — a dry run and a real sync hitting the same
-- remote concurrently is worse than a one-tick delay, and the reaper bounds how
-- long a stuck dry run can hold the slot. It also does not promise the REMOTE
-- system is untouched: "persists nothing" is a statement about Lobu's database,
-- not about side effects a connector performs upstream (marking read, etc.).
--
-- NOT NULL DEFAULT false is safe to add in one statement on PG11+ (the default
-- is stored in the catalog, no table rewrite), so no backfill step is needed.
-- Existing rows read as false, which is the correct meaning: everything written
-- before this column existed really did persist.

ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS dry_run boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS dry_run_preview jsonb;

COMMENT ON COLUMN public.runs.dry_run IS
  'When true the connector executes for real but the server persists nothing: no events, no entity creation, no artifact materialization, no checkpoint advance, no feed sync-state bookkeeping, no transcription queueing. Set at run creation; enforced in worker-api/run-lifecycle.ts (stream + complete) and scheduled/check-stalled-executions.ts (a reaped dry run is never retried as a real sync and never stamps feed failure state).';

COMMENT ON COLUMN public.runs.dry_run_preview IS
  'What a dry run WOULD have ingested: {items: [...], total, truncated}. Capped — see DRY_RUN_PREVIEW_LIMIT in worker-api/run-lifecycle.ts. NULL for normal runs.';
