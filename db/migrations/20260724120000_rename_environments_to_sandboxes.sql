-- migrate:up
--
-- Rename the `environments` domain to `sandboxes` so the storage matches the
-- user-facing "Sandboxes" surface (the Infrastructure › Sandboxes tab). #1914
-- unified the UI surface onto "providers" but left the table named
-- `environments`; this collapses that last naming drift. The table only ever
-- held org-level sandbox-provider config, so "sandbox" is what it actually is.
--
-- This is an atomic RENAME, not expand/contract: the chart deploys with
-- strategy Recreate + replicaCount 1 (charts/lobu/values.yaml), so the old pod
-- is fully gone before the pre-upgrade migration hook runs the new one — there
-- is no window where old code (SELECT … FROM environments) meets the renamed
-- schema. Same rollout guarantee #1914's column drop relied on.
--
-- Scope:
--  1. environments               -> sandboxes            (+ its constraints)
--  2. agents.environment_id      -> agents.sandbox_id
--  3. conversations.sandbox_environment_id -> conversations.sandbox_id
--  4. agent_secrets vault names  environment:<id>:<field> -> sandbox:<id>:<field>
--
-- NOT renamed: existing id VALUES keep their `env-` prefix. Ids are opaque and
-- referenced by agents.sandbox_id + the agent_secrets name segment; rewriting
-- them would cascade across three places for zero user benefit. New rows mint
-- `sbx-` ids (see createSandbox); both prefixes coexist harmlessly.

ALTER TABLE public.environments RENAME TO sandboxes;

ALTER TABLE public.sandboxes RENAME CONSTRAINT environments_pkey TO sandboxes_pkey;
ALTER TABLE public.sandboxes
  RENAME CONSTRAINT environments_provider_kind_check TO sandboxes_provider_kind_check;
ALTER TABLE public.sandboxes
  RENAME CONSTRAINT environments_org_name_key TO sandboxes_org_name_key;

ALTER TABLE public.agents RENAME COLUMN environment_id TO sandbox_id;

ALTER TABLE public.conversations
  RENAME COLUMN sandbox_environment_id TO sandbox_id;

-- Re-key the vault rows: environment:<id>:<field> -> sandbox:<id>:<field>.
-- agent_secrets is NOT the append-only events table, so a name UPDATE is the
-- correct in-place re-key. Every touched row is a live sandbox credential whose
-- name segment (the id between the colons) is preserved; only the prefix flips.
-- The name LIKE 'environment:%' predicate is served by the agent_secrets name
-- prefix index (text_pattern_ops), so only sandbox-prefixed rows are scanned.
UPDATE public.agent_secrets
SET name = 'sandbox:' || substring(name FROM length('environment:') + 1)
WHERE name LIKE 'environment:%';

-- migrate:down

UPDATE public.agent_secrets
SET name = 'environment:' || substring(name FROM length('sandbox:') + 1)
WHERE name LIKE 'sandbox:%';

ALTER TABLE public.conversations
  RENAME COLUMN sandbox_id TO sandbox_environment_id;

ALTER TABLE public.agents RENAME COLUMN sandbox_id TO environment_id;

ALTER TABLE public.sandboxes
  RENAME CONSTRAINT sandboxes_org_name_key TO environments_org_name_key;
ALTER TABLE public.sandboxes
  RENAME CONSTRAINT sandboxes_provider_kind_check TO environments_provider_kind_check;
ALTER TABLE public.sandboxes RENAME CONSTRAINT sandboxes_pkey TO environments_pkey;

ALTER TABLE public.sandboxes RENAME TO environments;
