-- Seed currency aliases on the Revolut financial account.
--
-- The `account` entity type declares governed spend metrics whose
-- `transactions` eventSet resolves each transaction by matching its currency
-- against the account's aliases. Aliases are entity data, not schema, so run
-- this once per environment after the account exists.
--
-- This org uses one consolidated Revolut account. Re-running replaces its
-- alias array from current completed card transactions and is idempotent.
\if :{?ORG_SLUG}
\else
  \echo 'ORG_SLUG is required'
  \quit 2
\endif

BEGIN;

SELECT id AS org_id
FROM organization
WHERE slug = :'ORG_SLUG'
LIMIT 1
\gset

SELECT id AS account_type_id
FROM entity_types
WHERE organization_id = :'org_id'
  AND slug = 'account'
  AND deleted_at IS NULL
LIMIT 1
\gset

INSERT INTO entities (
  organization_id, entity_type_id, name, slug, metadata, created_by,
  created_at, updated_at
)
SELECT
  :'org_id', :'account_type_id', 'Revolut', 'revolut',
  '{"institution":"Revolut","account_type":"current","is_active":true}'::jsonb,
  (SELECT "userId" FROM member WHERE "organizationId" = :'org_id' ORDER BY "createdAt" LIMIT 1),
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM entities
  WHERE organization_id = :'org_id'
    AND entity_type_id = :'account_type_id'
    AND slug = 'revolut'
    AND deleted_at IS NULL
);

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
    WHERE et.organization_id = e.organization_id AND et.slug = 'account'
  )
  AND e.name = 'Revolut'
  AND e.deleted_at IS NULL
  AND e.organization_id = :'org_id';

COMMIT;
