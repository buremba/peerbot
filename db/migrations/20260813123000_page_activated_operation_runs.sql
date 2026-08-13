-- Durable, device-agnostic activation for connector operations that should
-- begin only after the user visits an exact page in a user-owned browser tab.
--
-- transaction:false for the CONCURRENTLY index build on the busy `runs` table;
-- every statement is individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS activation_kind text,
  ADD COLUMN IF NOT EXISTS activation_target_urls text[],
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by_device_worker_id uuid,
  ADD COLUMN IF NOT EXISTS activation_tab_id bigint;

-- NOT VALID + VALIDATE keeps the existing-row scan off the exclusive-lock
-- window (same shape as 20260807120000). The preceding DROP makes the
-- ADD rerunnable after a mid-migration failure.
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_page_activation_shape_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_page_activation_shape_check CHECK (
    (
      activation_kind IS NULL
      AND activation_target_urls IS NULL
      AND activated_at IS NULL
      AND activated_by_device_worker_id IS NULL
      AND activation_tab_id IS NULL
    )
    OR
    (
      activation_kind = 'page_visit'
      AND cardinality(activation_target_urls) BETWEEN 1 AND 8
      AND expires_at IS NOT NULL
      AND (
        (activated_at IS NULL AND activated_by_device_worker_id IS NULL AND activation_tab_id IS NULL)
        OR
        (activated_at IS NOT NULL AND activated_by_device_worker_id IS NOT NULL AND activation_tab_id IS NOT NULL)
      )
    )
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_page_activation_shape_check;

-- Heal an INVALID carcass from a failed CONCURRENTLY build so every retry can
-- rebuild it (same shape as 20260812010000; both migration runners split
-- transaction:false sections into top-level statements).
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'runs_pending_page_activation_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.runs_pending_page_activation_idx';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_pending_page_activation_idx
  ON public.runs (created_by_user_id, organization_id, expires_at, id)
  WHERE status = 'pending'
    AND activation_kind = 'page_visit'
    AND activated_at IS NULL;

COMMENT ON COLUMN public.runs.activation_target_urls IS
  'Normalized exact HTTP(S) URLs that may activate a pending page_visit operation; never a selector or connector-specific rule.';

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS public.runs_pending_page_activation_idx;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_page_activation_shape_check;

ALTER TABLE public.runs
  DROP COLUMN IF EXISTS activation_kind,
  DROP COLUMN IF EXISTS activation_target_urls,
  DROP COLUMN IF EXISTS activated_at,
  DROP COLUMN IF EXISTS activated_by_device_worker_id,
  DROP COLUMN IF EXISTS activation_tab_id;
