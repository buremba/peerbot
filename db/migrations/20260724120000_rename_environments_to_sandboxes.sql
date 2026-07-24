-- migrate:up
--
-- Rename the `environments` domain to `sandboxes` so the storage matches the
-- user-facing "Sandboxes" surface (the Infrastructure › Sandboxes tab). #1914
-- unified the UI surface onto "providers" but left the table named
-- `environments`; this collapses that last naming drift. The table only ever
-- held org-level sandbox-provider config, so "sandbox" is what it actually is.
--
-- This is an atomic RENAME, not expand/contract. ROLLING-DEPLOY NOTE (accepted
-- risk, same class as 20260720140000 watcher→behavior hard cutover): the Helm
-- pre-upgrade hook runs this BEFORE the Deployment updates, so for the brief
-- pre-upgrade→Recreate gap the still-running old pod can hit the renamed
-- schema (SELECT … FROM environments → 42P01). Recreate + replicaCount 1
-- (charts/lobu/values.yaml) then terminates that pod and starts the new one —
-- it prevents two serving versions, NOT old-code-against-new-schema (see also
-- 20260714120000_drop_environments_scope_owner). We ACCEPT the brief fail
-- window: sandboxes is a low-traffic admin surface (config CRUD + rare pin
-- resolution), not the hot path of every chat turn, and the window is bounded
-- by migrate job duration + Recreate. Expand/contract (legacy view + dual
-- columns + dual vault prefix for one deploy) is the right follow-up only if
-- this table becomes high-frequency.
--
-- Scope:
--  1. environments               -> sandboxes            (+ its constraints)
--  2. agents.environment_id      -> agents.sandbox_id
--  3. conversations.sandbox_environment_id -> conversations.sandbox_id
--  4. agent_secrets vault names  environment:<id>:<field> -> sandbox:<id>:<field>
--  5. agent_run_input.token_claims JSONB  environmentId -> sandboxId (pending rows)
--
-- NOT renamed: existing id VALUES keep their `env-` prefix. Ids are opaque and
-- referenced by agents.sandbox_id + the agent_secrets name segment; rewriting
-- them would cascade across three places for zero user benefit. New rows mint
-- `sbx-` ids (see createSandbox); both prefixes coexist harmlessly.
--
-- RENAME TABLE/COLUMN has no IF EXISTS form that also renames constraints
-- atomically; prefer-robust-stmts can't be satisfied for bare renames. The
-- rollout break is accepted in the header above (same class as
-- 20260709130000 write-policy rename).

-- squawk-ignore renaming-table,prefer-robust-stmts
ALTER TABLE public.environments RENAME TO sandboxes;

-- RENAME CONSTRAINT has no IF EXISTS form.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT environments_pkey TO sandboxes_pkey;
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT environments_provider_kind_check TO sandboxes_provider_kind_check;
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT environments_org_name_key TO sandboxes_org_name_key;

-- squawk-ignore renaming-column,prefer-robust-stmts
ALTER TABLE public.agents RENAME COLUMN environment_id TO sandbox_id;

-- squawk-ignore renaming-column,prefer-robust-stmts
ALTER TABLE public.conversations RENAME COLUMN sandbox_environment_id TO sandbox_id;

-- Re-key the vault rows: environment:<id>:<field> -> sandbox:<id>:<field>.
-- agent_secrets is NOT the append-only events table, so a name UPDATE is the
-- correct in-place re-key. Every touched row is a sandbox credential whose name
-- segment (the id between the colons) is preserved; only the prefix flips. The
-- `environment:` prefix has only ever been minted by sandboxSecretName (née
-- environmentSecretName) — org-shared provider keys use `<slug>-<id>`, so no
-- other feature collides — hence the whole prefix is re-keyed rather than scoped
-- to live rows: that also carries any orphaned credential (a delete that never
-- purged) forward to the new prefix instead of stranding a decryptable token
-- under the old one. The predicate is served by the agent_secrets name prefix
-- index (text_pattern_ops).
UPDATE public.agent_secrets
SET name = 'sandbox:' || substring(name FROM length('environment:') + 1)
WHERE name LIKE 'environment:%';

-- Re-key the persisted worker-run claims that straddle this deploy. A pending
-- agent_run_input replays its FROZEN token_claims after a restart (Recreate
-- interrupts in-flight turns), minting a fresh worker token from them. Old rows
-- stored the sandbox binding under `environmentId`; new code reads `sandboxId`,
-- so without this re-key a provider-pinned turn pending across the deploy would
-- mint a sandbox-LESS token and silently execute in the host realm (system-env /
-- OIDC creds) instead of its pinned sandbox — the exact downgrade the runtime
-- route's fail-closed path exists to prevent. Only 'pending' rows can replay;
-- 'completed' ones never do, so leave them. Guard on the key's presence so the
-- statement is idempotent and skips already-migrated / builtin rows.
UPDATE public.agent_run_input
SET token_claims =
  (token_claims - 'environmentId')
  || jsonb_build_object('sandboxId', token_claims -> 'environmentId')
WHERE status = 'pending'
  AND token_claims ? 'environmentId';

-- migrate:down

UPDATE public.agent_run_input
SET token_claims =
  (token_claims - 'sandboxId')
  || jsonb_build_object('environmentId', token_claims -> 'sandboxId')
WHERE status = 'pending'
  AND token_claims ? 'sandboxId';

UPDATE public.agent_secrets
SET name = 'environment:' || substring(name FROM length('sandbox:') + 1)
WHERE name LIKE 'sandbox:%'
  AND split_part(name, ':', 2) IN (SELECT id FROM public.sandboxes);

-- squawk-ignore renaming-column,prefer-robust-stmts
ALTER TABLE public.conversations RENAME COLUMN sandbox_id TO sandbox_environment_id;

-- squawk-ignore renaming-column,prefer-robust-stmts
ALTER TABLE public.agents RENAME COLUMN sandbox_id TO environment_id;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT sandboxes_org_name_key TO environments_org_name_key;
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT sandboxes_provider_kind_check TO environments_provider_kind_check;
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME CONSTRAINT sandboxes_pkey TO environments_pkey;

-- squawk-ignore renaming-table,prefer-robust-stmts
ALTER TABLE public.sandboxes RENAME TO environments;
