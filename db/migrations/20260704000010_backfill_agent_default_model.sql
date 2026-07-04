-- migrate:up

-- Backfill the `model` column (now the single agent defaultModel) for any agent
-- whose effective model lived ONLY in the legacy `model_selection` /
-- `provider_model_preferences` columns — so the follow-up migration that DROPs
-- those columns loses nothing. Mirrors the old resolveEffectiveModelRef order:
--   1. model_selection.pinnedModel  (when its provider is the primary installed)
--   2. provider_model_preferences[<primary installed provider>]
-- Only rows with an empty `model` column are touched; a populated `model`
-- already IS the defaultModel and wins.
--
-- Idempotent: re-running only fills still-empty rows. No-op on an org that never
-- used the per-agent Providers page (both legacy columns default to {} / []).

WITH resolved AS (
    SELECT
        a.id,
        COALESCE(
            -- (1) pinned model, if its provider prefix is the primary installed one
            CASE
                WHEN NULLIF(a.model_selection->>'pinnedModel', '') IS NOT NULL
                     AND split_part(a.model_selection->>'pinnedModel', '/', 1)
                         = (a.installed_providers->0->>'providerId')
                THEN a.model_selection->>'pinnedModel'
            END,
            -- (2) the primary installed provider's stored preference
            NULLIF(
                a.provider_model_preferences->>(a.installed_providers->0->>'providerId'),
                ''
            )
        ) AS resolved_model
    FROM agents a
    WHERE (a.model IS NULL OR a.model = '')
)
UPDATE agents a
SET model = r.resolved_model,
    updated_at = now()
FROM resolved r
WHERE a.id = r.id
  AND r.resolved_model IS NOT NULL;

-- migrate:down

-- No-op: this backfill only populated empty `model` columns from data that still
-- lives in model_selection / provider_model_preferences (not dropped yet), so
-- there is nothing to reverse without guessing which rows were backfilled.
SELECT 1;
