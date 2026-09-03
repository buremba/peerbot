-- migrate:up

-- `automations.agent_id` names the MANAGED Lobu agent that executes this
-- Automation's runs. It is one of three executor lanes: a managed agent, a
-- device worker (`device_worker_id`), or — when both are null — an open manual
-- lane any connected MCP client may claim and complete. The bare name reads as
-- "some agent" and sits next to four unrelated `agent_id` columns
-- (`connections`, `agent_users`, `agent_grants`, `write_policies.target_agent_id`),
-- so `managed_agent_id` says which lane it selects.
--
-- The same pass closes the hole that motivated it. The column carries NO
-- foreign key to `agents`, and `resolveAutomationOwner` resolves ownership as
-- "NULL means unowned, anything else must name a live agent". An empty string
-- is neither: it slips past the NULL guard, misses the `agents` lookup, and
-- leaves the Automation permanently deny-listed by the entity mutation gate —
-- every declared output silently skipped while `complete_window` still reports
-- success. One production Automation reached that state. A CHECK makes it
-- unrepresentable, which is also what lets the resolver keep its cheap
-- `IS NULL` test.
--
-- Operational cost: `automations` is a bounded config table — 192 rows in
-- production, counted 2026-09-03. The UPDATE touches single-digit rows, both
-- renames are O(1) catalog flips, and validating the CHECK scans those 192
-- rows. dbmate runs this file in one transaction, so the rename's ACCESS
-- EXCLUSIVE lock is held until commit either way. Not timed against a
-- production-sized restore; at this row count every statement is bounded by
-- catalog latency rather than by table size. This migration is NOT
-- `lobu:no-quiesce` — the code running before it selects `agent_id` by name
-- and breaks the moment the rename lands.

-- 1. Catalog-only rename. Views that read the column follow it automatically
--    (their stored parse trees reference it by attnum); plpgsql bodies are
--    plain text and do NOT, so the one function naming it is recreated below.
DO $rename_managed_agent_id$
DECLARE
  retired_exists boolean;
  canonical_exists boolean;
BEGIN
  SELECT
    EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.automations'::regclass
        AND attname = 'agent_id' AND NOT attisdropped
    ),
    EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.automations'::regclass
        AND attname = 'managed_agent_id' AND NOT attisdropped
    )
  INTO retired_exists, canonical_exists;

  IF retired_exists AND canonical_exists THEN
    RAISE EXCEPTION
      'both automations.agent_id and automations.managed_agent_id exist';
  END IF;

  IF retired_exists THEN
    ALTER TABLE public.automations RENAME COLUMN agent_id TO managed_agent_id;
  ELSIF NOT canonical_exists THEN
    RAISE EXCEPTION
      'neither automations.agent_id nor automations.managed_agent_id exists';
  END IF;
END
$rename_managed_agent_id$;

-- 2. Index identifiers do not follow a column rename.
ALTER INDEX IF EXISTS public.idx_automations_agent_id
  RENAME TO idx_automations_managed_agent_id;
ALTER INDEX IF EXISTS public.automations_agent_recent
  RENAME TO automations_managed_agent_recent;

-- 3. Deleting an agent archives the Automations it executed. The body is text,
--    so it has to be rewritten against the new column name.
CREATE OR REPLACE FUNCTION public.archive_automations_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.automations automation
  SET status = 'archived', updated_at = current_timestamp
  WHERE automation.status = 'active'
    AND automation.organization_id = OLD.organization_id
    AND automation.managed_agent_id = OLD.id;
  RETURN OLD;
END
$archive$;

-- 4. Drop the dangling-owner rows to the unowned lane they behave as. Runs
--    after the rename so a re-run against an already-renamed schema still
--    finds the column.
UPDATE public.automations SET managed_agent_id = NULL WHERE managed_agent_id = '';

-- 5. Make the state that caused the outage unrepresentable. NOT VALID + VALIDATE
--    is the lock-lint shape; inside dbmate's single transaction it buys nothing
--    over a plain ADD, and at this row count neither does.
ALTER TABLE public.automations
  DROP CONSTRAINT IF EXISTS automations_managed_agent_id_nonempty;
ALTER TABLE public.automations
  ADD CONSTRAINT automations_managed_agent_id_nonempty
  CHECK (managed_agent_id IS NULL OR managed_agent_id <> '') NOT VALID;
ALTER TABLE public.automations
  VALIDATE CONSTRAINT automations_managed_agent_id_nonempty;

COMMENT ON COLUMN public.automations.managed_agent_id IS
  'Managed Lobu agent that executes this Automation''s runs (server dispatch lane). NULL means no managed agent: the Automation is device-pinned via device_worker_id, or — with neither set and no triggers — manual-only and claimable by any connected MCP client. Never the empty string; carries no FK, so a non-null value that names no live agent fails the mutation gate closed.';

-- migrate:down

ALTER TABLE public.automations
  DROP CONSTRAINT IF EXISTS automations_managed_agent_id_nonempty;

ALTER INDEX IF EXISTS public.automations_managed_agent_recent
  RENAME TO automations_agent_recent;
ALTER INDEX IF EXISTS public.idx_automations_managed_agent_id
  RENAME TO idx_automations_agent_id;

-- squawk-ignore prefer-robust-stmts,renaming-column -- the down side of a deliberate rename: a rollback runs against code that expects the retired name back, and dbmate wraps this file in one transaction
ALTER TABLE public.automations RENAME COLUMN managed_agent_id TO agent_id;

CREATE OR REPLACE FUNCTION public.archive_automations_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.automations automation
  SET status = 'archived', updated_at = current_timestamp
  WHERE automation.status = 'active'
    AND automation.organization_id = OLD.organization_id
    AND automation.agent_id = OLD.id;
  RETURN OLD;
END
$archive$;
