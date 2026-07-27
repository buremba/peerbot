-- migrate:up transaction:false

-- Add 'expired' to the runs.approval_status vocabulary.
--
-- A run parked at approval_status='pending' is deliberately exempt from the
-- short-horizon claim reaper (scheduled/stale-run-sweeper.ts, #2044): no worker
-- will ever claim it, so force-timing it out before a human can decide is wrong.
-- That exemption was never paired with a LONG-horizon expiry, so undecided
-- approvals accumulate forever.
--
-- 'expired' is its own value rather than a reuse of 'rejected' because the two
-- mean different things downstream: 'rejected' is a HUMAN decision — it is what
-- the batch-reject path mines into a `correction` event the Behavior learns from
-- on its next turn — while 'expired' is the system giving up on an undecided
-- run. A reviewer who never looked at a proposal did not reject it, and an agent
-- must not train on silence as if it were disapproval.
--
-- LOCK SAFETY. `runs` is one of the hottest tables in the system, so the swap is
-- deliberately NOT one transaction. DROP CONSTRAINT and ADD CONSTRAINT both take
-- ACCESS EXCLUSIVE, and Postgres holds that lock until COMMIT — so bundling the
-- VALIDATE into the same transaction would run its full-table scan *under*
-- ACCESS EXCLUSIVE and stall all `runs` traffic for the length of the scan.
-- Instead (transaction:false runs each statement standalone; see
-- packages/server/src/db/migration-loader.ts):
--   1. ADD the widened CHECK under a TEMPORARY name as NOT VALID — a brief
--      ACCESS EXCLUSIVE that takes no scan, then commits.
--   2. VALIDATE it on its own — takes only SHARE UPDATE EXCLUSIVE, so concurrent
--      reads and writes keep running while the scan proceeds.
--   3. DROP the old constraint and rename the replacement into its place — both
--      catalog-only, so each lock is momentary.
--
-- The column is never left unconstrained: between steps 1 and 3 BOTH the old
-- constraint and the new one guard it. The widened predicate accepts every value
-- the old one did, so VALIDATE cannot fail on existing rows.
--
-- RETRY SAFETY. Each step is guarded because ADD/RENAME CONSTRAINT have no
-- `IF NOT EXISTS`, and under transaction:false every statement commits on its
-- own. Without the guards a crash mid-sequence would leave the temp constraint
-- behind and fail every retry with "already exists", so the migration could
-- never record as applied. Re-running the section from any point converges.
DO $add_new$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.runs
        ADD CONSTRAINT runs_approval_status_check_new
        CHECK (approval_status = ANY (ARRAY[
          'pending'::text,
          'approved'::text,
          'rejected'::text,
          'expired'::text,
          'auto'::text
        ]))
        NOT VALID
    $ddl$;
  END IF;
END
$add_new$;

-- Step 2: validate on its own so the scan runs under SHARE UPDATE EXCLUSIVE.
-- Guarded so the statement is a no-op once the constraint is already validated
-- (or already renamed away by a completed earlier attempt), which keeps the
-- whole section convergent on retry from any crash point.
DO $validate_new$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.runs
      VALIDATE CONSTRAINT runs_approval_status_check_new;
  END IF;
END
$validate_new$;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

-- Guarded for the same retry reason: after a completed run the temp name is
-- gone, so a bare RENAME would fail on re-execution.
DO $rename_new$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_new'
  ) THEN
    ALTER TABLE public.runs
      RENAME CONSTRAINT runs_approval_status_check_new TO runs_approval_status_check;
  END IF;
END
$rename_new$;

-- migrate:down transaction:false

-- Fold any expired rows back into 'rejected' FIRST: the narrower constraint
-- cannot validate while 'expired' rows exist.
UPDATE public.runs SET approval_status = 'rejected' WHERE approval_status = 'expired';

-- Same never-unconstrained, never-stalling, retry-safe ordering as the up path.
DO $add_old$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.runs
        ADD CONSTRAINT runs_approval_status_check_old
        CHECK (approval_status = ANY (ARRAY[
          'pending'::text,
          'approved'::text,
          'rejected'::text,
          'auto'::text
        ]))
        NOT VALID
    $ddl$;
  END IF;
END
$add_old$;

DO $validate_old$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.runs
      VALIDATE CONSTRAINT runs_approval_status_check_old;
  END IF;
END
$validate_old$;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

DO $rename_old$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass
      AND conname = 'runs_approval_status_check_old'
  ) THEN
    ALTER TABLE public.runs
      RENAME CONSTRAINT runs_approval_status_check_old TO runs_approval_status_check;
  END IF;
END
$rename_old$;
