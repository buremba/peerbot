-- Seed currency aliases on the Revolut account asset.
--
-- The `asset` entity type declares governed spend metrics whose `transactions`
-- eventSet resolves each transaction to an account by matching the
-- transaction's `currency` against the asset's `metadata.aliases`. Aliases are
-- ENTITY DATA, not schema, so `lobu apply` does not set them — run this once
-- (per environment) after the asset exists.
--
-- This org runs a single consolidated Revolut account (the per-currency assets
-- were retired), so that one active asset is aliased with every currency it
-- transacts in and owns all transactions; `currency` is a metric dimension.
-- The asset alias array is REPLACED (not appended) so re-running is idempotent.
--
-- Scope to the org slug from lobu.config.ts when running against a shared database.
UPDATE entities AS e
SET metadata = jsonb_set(
  coalesce(e.metadata, '{}'::jsonb),
  '{aliases}',
  (
    SELECT coalesce(jsonb_agg(DISTINCT ev.metadata->>'currency'), '[]'::jsonb)
    FROM events ev
    WHERE ev.organization_id = e.organization_id
      AND ev.semantic_type = 'transaction'
      AND ev.metadata->>'state' = 'COMPLETED'
      AND ev.metadata->>'transaction_type' = 'CARD_PAYMENT'
      AND ev.metadata->>'currency' IS NOT NULL
  )
)
WHERE e.entity_type_id = (
    SELECT id FROM entity_types et
    WHERE et.organization_id = e.organization_id AND et.slug = 'asset'
  )
  AND e.name = 'Revolut'
  AND e.deleted_at IS NULL
  AND e.organization_id = (
    SELECT id FROM organizations WHERE slug = 'personal-agent' LIMIT 1
  );
