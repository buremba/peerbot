-- migrate:up

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
-- Swap the CHECK inside one transaction so there is never a window where
-- approval_status is unconstrained. NOT VALID + VALIDATE keeps the existing-row
-- scan off the ACCESS EXCLUSIVE lock (the widened predicate accepts every value
-- the old one did, so validation cannot fail).
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

ALTER TABLE public.runs
  ADD CONSTRAINT runs_approval_status_check
  CHECK (approval_status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'rejected'::text,
    'expired'::text,
    'auto'::text
  ]))
  NOT VALID;

ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_approval_status_check;

-- migrate:down

-- Fold any expired rows back into 'rejected' so the narrower constraint can be
-- re-applied without failing on live data.
UPDATE public.runs SET approval_status = 'rejected' WHERE approval_status = 'expired';

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_approval_status_check;

ALTER TABLE public.runs
  ADD CONSTRAINT runs_approval_status_check
  CHECK (approval_status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'rejected'::text,
    'auto'::text
  ]))
  NOT VALID;

ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_approval_status_check;
