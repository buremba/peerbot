-- migrate:up

-- Merge the agent's two model-provider columns into ONE ordered `models` list:
-- a jsonb array of explicit `<providerSlug>/<model>` refs. Index 0 = the
-- agent's default; the rest are its alternates (fallback candidates and the
-- per-channel override pick-list). NULL/empty ⇒ every org provider is
-- available and the default falls through to the org default model.
--
-- ATOMIC CUTOVER: the legacy `model` + `installed_providers` columns are
-- backfilled into `models` and then DROPPED in this same migration — there is
-- no dual-write window. This migration must run as part of the coordinated
-- deploy: old server code cannot run against the post-migration schema.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS models jsonb;

-- Backfill order per agent:
--   1. The legacy `model` ref, when it is a real `<slug>/<model>` (skipped when
--      empty / 'auto' / slash-less). A `<slug>/auto` ref contributes its SLUG
--      (resolved to a concrete model below) but not the 'auto' ref itself —
--      'auto' is removed everywhere.
--   2. Each `installed_providers` entry, in install order, whose slug isn't
--      already covered — resolved to a CONCRETE model `<slug>/<default>` from:
--        a. the provider's catalog defaultModel (config/providers.json,
--         inlined below — a SQL migration cannot read the config file), else
--        b. the org's own `inference_providers` row for that slug
--           (`capabilities.text.model` — the same field the runtime uses as a
--           synthesized org-provider's default), else
--        c. the entry is SKIPPED (never emit `<slug>/auto`).
--
-- RESTRICTION INVARIANT (critical): an agent that was RESTRICTED before this
-- migration (had a non-empty `model` OR any `installed_providers` entry) must
-- NEVER end up with `models = NULL` — NULL is allow-all, so that would silently
-- WIDEN its access. When such an agent's providers resolve to zero concrete
-- refs (e.g. a `chatgpt/auto`-only agent with no catalog default and no org
-- row), we preserve its restriction with a deterministic sentinel ref
-- `<slug>/__unresolved__` per distinct restricted slug: non-NULL (not allow-all)
-- and it never matches a real model, so the gate stays closed rather than open.
--
-- Idempotent: only rows with `models IS NULL` are touched. The join is on the
-- composite PK (id, organization_id) — the same agent id exists in many orgs.

WITH provider_defaults(slug, default_model) AS (
    -- Snapshot of config/providers.json defaultModel per provider id at
    -- migration-authoring time. Providers without a defaultModel there
    -- (chatgpt, elevenlabs) are intentionally absent.
    VALUES
        ('claude', 'claude-sonnet-5'),
        ('groq', 'llama-3.3-70b-versatile'),
        ('gemini', 'gemini-2.5-pro'),
        ('together-ai', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'),
        ('nvidia', 'nvidia/moonshotai/kimi-k2.6'),
        ('z-ai', 'glm-5.2'),
        ('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct'),
        ('mistral', 'mistral-large-latest'),
        ('deepseek', 'deepseek-v4-flash'),
        ('openrouter', 'anthropic/claude-sonnet-5'),
        ('cerebras', 'llama-3.3-70b'),
        ('opencode-zen', 'claude-sonnet-4-6'),
        ('xai', 'grok-4'),
        ('perplexity', 'sonar'),
        ('cohere', 'command-a-03-2025'),
        ('openai', 'gpt-5.6-sol')
),
restricted AS (
    -- Agents that were RESTRICTED before this migration: a non-empty legacy
    -- `model` OR at least one installed provider. These must never become NULL.
    SELECT a.id, a.organization_id
    FROM agents a
    WHERE a.models IS NULL
      AND (
          COALESCE(a.model, '') <> ''
          OR jsonb_array_length(COALESCE(a.installed_providers, '[]'::jsonb)) > 0
      )
),
candidates AS (
    -- ord 0: the legacy model ref's slug (+ the explicit ref when concrete).
    SELECT a.id,
           a.organization_id,
           0 AS ord,
           split_part(a.model, '/', 1) AS slug,
           CASE
               WHEN substr(a.model, position('/' in a.model) + 1)
                    NOT IN ('', 'auto')
               THEN a.model
           END AS explicit_ref
    FROM agents a
    WHERE a.models IS NULL
      AND COALESCE(a.model, '') <> ''
      AND position('/' in a.model) > 1
  UNION ALL
    -- ord 1..n: installed providers, in install order (slug only).
    SELECT a.id,
           a.organization_id,
           ip.ord::int AS ord,
           ip.value->>'providerId' AS slug,
           NULL AS explicit_ref
    FROM agents a,
         jsonb_array_elements(COALESCE(a.installed_providers, '[]'::jsonb))
             WITH ORDINALITY AS ip(value, ord)
    WHERE a.models IS NULL
      AND COALESCE(ip.value->>'providerId', '') <> ''
),
resolved AS (
    -- Concrete ref per candidate: the explicit legacy ref wins; otherwise the
    -- slug's catalog default, else the org row's text model. In EVERY prefixed
    -- path the model is qualified to `<slug>/<model>` ONLY when it isn't already
    -- `<slug>/…`-qualified — provider-native ids can contain slashes (openrouter
    -- `anthropic/…`, nvidia `nvidia/moonshotai/…`), so a catalog default or org
    -- model that already carries its slug must NOT be double-prefixed to
    -- `<slug>/<slug>/…`. NULL ⇒ no concrete model.
    SELECT c.id,
           c.organization_id,
           c.ord,
           c.slug,
           CASE
               WHEN c.explicit_ref IS NOT NULL THEN c.explicit_ref
               WHEN pd.default_model IS NOT NULL
                   THEN CASE
                       WHEN pd.default_model LIKE c.slug || '/%'
                       THEN pd.default_model
                       ELSE c.slug || '/' || pd.default_model
                   END
               WHEN NULLIF(org.capabilities->'text'->>'model', '') IS NOT NULL
                   THEN CASE
                       WHEN (org.capabilities->'text'->>'model')
                            LIKE c.slug || '/%'
                       THEN org.capabilities->'text'->>'model'
                       ELSE c.slug || '/' || (org.capabilities->'text'->>'model')
                   END
           END AS ref
    FROM candidates c
    LEFT JOIN provider_defaults pd
           ON pd.slug = c.slug
    LEFT JOIN inference_providers org
           ON org.organization_id = c.organization_id
          AND org.slug = c.slug
          AND org.deleted_at IS NULL
),
ranked AS (
    -- First appearance per slug wins (the legacy model ref sorts first). A slug
    -- whose only candidates resolved to NULL still appears here (ref NULL) so we
    -- can emit a restriction sentinel for it below — otherwise a restricted
    -- agent whose every provider is unresolvable would fold to zero rows.
    SELECT id, organization_id, ord, slug, ref,
           ROW_NUMBER() OVER (
               PARTITION BY organization_id, id, slug ORDER BY ord
           ) AS rn
    FROM resolved
),
refs AS (
    -- The concrete refs (first appearance per slug), plus — for a RESTRICTED
    -- agent whose slug resolved to no concrete model — a deterministic sentinel
    -- `<slug>/__unresolved__` so the agent stays non-NULL (restricted), never
    -- silently widening to allow-all.
    SELECT rk.id, rk.organization_id, rk.ord,
           COALESCE(rk.ref, rk.slug || '/__unresolved__') AS ref
    FROM ranked rk
    WHERE rk.rn = 1
      AND (rk.ref IS NOT NULL
           OR EXISTS (
               SELECT 1 FROM restricted r
               WHERE r.id = rk.id AND r.organization_id = rk.organization_id
           ))
),
folded AS (
    SELECT id, organization_id,
           jsonb_agg(ref ORDER BY ord) AS models
    FROM refs
    GROUP BY id, organization_id
),
-- A RESTRICTED agent that produced NO folded row at all (e.g. legacy
-- `model = 'auto'` or a bare unqualified `model = 'gpt-4o'` with no providers —
-- the slash filter drops it as a candidate, so `folded` has nothing for it)
-- must STILL end up non-NULL, or it would silently widen to allow-all after the
-- column drop. Give it a single deterministic `legacy/__unresolved__` sentinel:
-- non-NULL (restricted) and never routable, so the gate stays closed.
restricted_no_fold AS (
    SELECT r.id, r.organization_id,
           '["legacy/__unresolved__"]'::jsonb AS models
    FROM restricted r
    WHERE NOT EXISTS (
        SELECT 1 FROM folded f
        WHERE f.id = r.id AND f.organization_id = r.organization_id
    )
),
final_models AS (
    SELECT id, organization_id, models FROM folded
    UNION ALL
    SELECT id, organization_id, models FROM restricted_no_fold
)
UPDATE agents a
SET models = f.models,
    updated_at = now()
FROM final_models f
WHERE a.id = f.id
  AND a.organization_id = f.organization_id
  AND a.models IS NULL;

-- Drop the legacy columns AFTER the backfill (atomic cutover, no dual-write).
ALTER TABLE agents DROP COLUMN IF EXISTS model;
ALTER TABLE agents DROP COLUMN IF EXISTS installed_providers;

-- Defense-in-depth for the per-binding (Listen) model override: null out any
-- legacy `agent_channel_bindings.model` that is NOT a valid `<slug>/<model>`
-- ref (e.g. the retired literal 'auto', or a bare model id with no provider
-- prefix). The runtime already fails such overrides closed (drops them and
-- falls to the agent default), but clearing them here keeps the stored state
-- honest and avoids re-warning on every message. Idempotent.
UPDATE agent_channel_bindings
SET model = NULL
WHERE model IS NOT NULL
  AND (
      position('/' in model) <= 1
      OR model LIKE '%/'
      OR split_part(model, '/', 2) = 'auto'
  );

-- migrate:down

-- Best-effort restore: models[0] becomes the pinned `model`, and each distinct
-- slug prefix becomes an installed_providers entry (install timestamps are not
-- recoverable; now() epoch millis are stamped).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS installed_providers jsonb DEFAULT '[]'::jsonb;

UPDATE agents a
SET model = a.models->>0,
    installed_providers = COALESCE(
        (
            SELECT jsonb_agg(
                       jsonb_build_object(
                           'providerId', slugs.slug,
                           'installedAt', (extract(epoch from now()) * 1000)::bigint
                       )
                       ORDER BY slugs.first_ord
                   )
            FROM (
                SELECT split_part(ref.value, '/', 1) AS slug,
                       min(ref.ord) AS first_ord
                FROM jsonb_array_elements_text(a.models)
                         WITH ORDINALITY AS ref(value, ord)
                WHERE position('/' in ref.value) > 1
                GROUP BY split_part(ref.value, '/', 1)
            ) AS slugs
        ),
        '[]'::jsonb
    )
WHERE a.models IS NOT NULL;

ALTER TABLE agents DROP COLUMN IF EXISTS models;
