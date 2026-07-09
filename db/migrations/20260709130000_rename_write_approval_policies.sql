-- migrate:up

-- Contract phase: rename entity_approval_policies -> write_approval_policies now
-- that the table governs three write classes (entity, agent_config,
-- connector_action), not just entities. The name was a v1 misnomer.
--
-- Deploy note: this is a BARE rename. dbmate runs in the Helm pre-upgrade Job
-- BEFORE the new pods roll, and the old pods (which still query the old name)
-- keep serving during the rollout overlap — so agent/watcher WRITE gating 500s
-- for the ~30-90s overlap window, then recovers once the new pods (which query
-- the new name) are live. Reads/UI degrade to the default policy during that
-- window; nothing is lost. Accepted as a one-time blip on this deploy.
--
-- Postgres renames the table in place (data, FKs, and dependent objects follow),
-- but does NOT rename indexes/constraints — do those explicitly so names track
-- the table. IF EXISTS guards keep the migration idempotent across replays.
-- The implicit PK and the FK constraints (…_organization_id_fkey,
-- …_entity_id_fkey) keep their auto-generated old-name prefixes: nothing
-- references them by string and renaming them is purely cosmetic, so they're
-- left as-is to avoid a name-guessing error mid-deploy.

ALTER TABLE IF EXISTS public.entity_approval_policies
  RENAME TO write_approval_policies;

-- Indexes (from the create + expand migrations).
ALTER INDEX IF EXISTS public.entity_approval_policies_org_lookup
  RENAME TO write_approval_policies_org_lookup;
ALTER INDEX IF EXISTS public.entity_approval_policies_class_principal
  RENAME TO write_approval_policies_class_principal;
ALTER INDEX IF EXISTS public.entity_approval_policies_class_principal_scope_key
  RENAME TO write_approval_policies_class_principal_scope_key;

-- Check constraints (widened in the expand migration).
ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT entity_approval_policies_create_mode_check
  TO write_approval_policies_create_mode_check;
ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT entity_approval_policies_update_mode_check
  TO write_approval_policies_update_mode_check;
ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT entity_approval_policies_delete_mode_check
  TO write_approval_policies_delete_mode_check;

-- migrate:down

ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT write_approval_policies_delete_mode_check
  TO entity_approval_policies_delete_mode_check;
ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT write_approval_policies_update_mode_check
  TO entity_approval_policies_update_mode_check;
ALTER TABLE public.write_approval_policies
  RENAME CONSTRAINT write_approval_policies_create_mode_check
  TO entity_approval_policies_create_mode_check;

ALTER INDEX IF EXISTS public.write_approval_policies_class_principal_scope_key
  RENAME TO entity_approval_policies_class_principal_scope_key;
ALTER INDEX IF EXISTS public.write_approval_policies_class_principal
  RENAME TO entity_approval_policies_class_principal;
ALTER INDEX IF EXISTS public.write_approval_policies_org_lookup
  RENAME TO entity_approval_policies_org_lookup;

ALTER TABLE IF EXISTS public.write_approval_policies
  RENAME TO entity_approval_policies;
