-- One-time personal-agent migration after the new `account` type exists.
--
-- It normalizes current balance-sheet facts into append-only observations,
-- transfers the Revolut metric aliases to the account grain, and soft-deletes
-- every legacy asset instance. Re-run `lobu apply` afterwards so prune can
-- remove the now-empty `asset` type. The script is idempotent.
-- Deployment order: apply the account schema, run this migration, then apply
-- again to prune the legacy type.
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

WITH components AS (
  SELECT
    'revolut-current-gbp' AS component_key,
    'Revolut cash and savings GBP' AS title,
    'revolut-cash' AS source,
    'Revolut' AS institution,
    'revolut-current' AS account_key,
    'cash' AS account_type,
    'cash' AS asset_class,
    'GBP' AS currency,
    ((e.metadata->>'gbp_current_balance')::numeric
      + (e.metadata->>'gbp_savings_balance')::numeric) AS value,
    ((e.metadata->>'gbp_current_balance')::numeric
      + (e.metadata->>'gbp_savings_balance')::numeric) AS value_low,
    ((e.metadata->>'gbp_current_balance')::numeric
      + (e.metadata->>'gbp_savings_balance')::numeric) AS value_high,
    'reported_balance' AS valuation_basis,
    7 AS freshness_days,
    e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:revolut:cash-snapshot:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'revolut-current-usd', 'Revolut current USD', 'revolut-cash',
    'Revolut', 'revolut-current', 'cash', 'cash', 'USD',
    (e.metadata->>'usd_current_balance')::numeric,
    (e.metadata->>'usd_current_balance')::numeric,
    (e.metadata->>'usd_current_balance')::numeric,
    'reported_balance', 7, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:revolut:cash-snapshot:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'chase-cash', 'Chase cash', 'chase', 'Chase', 'chase-current',
    'cash', 'cash', coalesce(e.metadata->>'currency', 'GBP'),
    (e.metadata->>'balance')::numeric, (e.metadata->>'balance')::numeric,
    (e.metadata->>'balance')::numeric, 'reported_balance', 30, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:chase:balance-rate-net-transfer:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'trading212-investment', 'Trading 212 investments', 'trading212',
    'Trading 212', 'trading212-investments', 'brokerage', 'security',
    coalesce(e.metadata->>'currency', 'GBP'),
    (e.metadata->>'balance')::numeric, (e.metadata->>'balance')::numeric,
    (e.metadata->>'balance')::numeric, 'broker_snapshot', 30, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:trading212:balance-screenshot:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'retirement-policy', 'Retirement policy', 'retirement',
    coalesce(e.metadata->>'possible_provider', 'Retirement policy'),
    'retirement-policy', 'retirement', 'retirement', 'GBP',
    (e.metadata->>'retirement_policy_balance_gbp')::numeric,
    (e.metadata->>'retirement_policy_balance_gbp')::numeric,
    (e.metadata->>'retirement_policy_balance_gbp')::numeric,
    'reported_balance', 90, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'scottish-retirement-%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'qnb-eurobond', 'QNB Finansbank eurobond', 'qnb', 'QNB Finansbank',
    'qnb-eurobond', 'investment', 'eurobond', 'USD',
    (e.metadata->>'reported_amount_usd')::numeric,
    (e.metadata->>'reported_amount_usd')::numeric,
    (e.metadata->>'reported_amount_usd')::numeric,
    coalesce(e.metadata->>'valuation_basis', 'reported_balance'), 30, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'qnb-finansbank-eurobond-%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'binance', 'Binance holdings', 'binance', 'Binance', 'binance',
    'investment', 'crypto', 'USD',
    (e.metadata->>'binance_total_usd')::numeric,
    (e.metadata->>'binance_total_usd')::numeric,
    (e.metadata->>'binance_total_usd')::numeric,
    coalesce(e.metadata->>'binance_composition', 'reported_balance'), 30, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-binance-refine-%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'refine-angel-investment', 'refine.dev angel investment',
    'private-investment', 'refine.dev', 'refine-angel-investment',
    'investment', 'private-equity', 'USD',
    (e.metadata->>'refine_dev_angel_investment_usd')::numeric,
    (e.metadata->>'refine_dev_angel_investment_usd')::numeric,
    (e.metadata->>'refine_dev_angel_investment_usd')::numeric,
    coalesce(e.metadata->>'refine_dev_valuation_basis', 'reported_balance'),
    30, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-binance-refine-%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'kartal-property', 'Kartal property', 'property', 'Kartal property',
    'kartal-property', 'property', 'property',
    coalesce(e.metadata->>'currency', 'TRY'),
    (e.metadata->>'valuation_midpoint')::numeric,
    (e.metadata->>'valuation_low')::numeric,
    (e.metadata->>'valuation_high')::numeric,
    'market_range_midpoint', 365, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:property-valuation:kartal-dap:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'izmit-property', 'İzmit–Akmeşe land', 'property', 'İzmit property',
    'izmit-property', 'property', 'property',
    coalesce(e.metadata->>'currency', 'TRY'),
    (e.metadata->>'valuation_midpoint')::numeric,
    (e.metadata->>'valuation_low')::numeric,
    (e.metadata->>'valuation_high')::numeric,
    'market_range_midpoint', 365, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:property-valuation:izmit-akmese:%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'kartepe-property', 'Kartepe–Balaban parcel', 'property', 'Kartepe property',
    'kartepe-property', 'property', 'property',
    coalesce(e.metadata->>'currency', 'TRY'),
    (e.metadata->>'valuation_midpoint')::numeric,
    (e.metadata->>'valuation_low')::numeric,
    (e.metadata->>'valuation_high')::numeric,
    'market_range_midpoint', 365, e.occurred_at
  FROM LATERAL (
    SELECT metadata, occurred_at FROM events
    WHERE organization_id = :'org_id'
      AND superseded_by IS NULL
      AND metadata->>'_lobu_idempotency_key' LIKE 'finance-profile:property-valuation:kartepe-balaban-%'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) e

  UNION ALL
  SELECT
    'camden-property-equity', 'Camden property net equity', 'property',
    legacy.name, 'camden-property', 'property', 'property',
    coalesce(legacy.metadata->>'currency', 'GBP'),
    coalesce(
      nullif(legacy.metadata->>'net_value', '')::numeric,
      nullif(legacy.metadata->>'value', '')::numeric
        - coalesce(nullif(legacy.metadata->>'mortgage', '')::numeric, 0)
    ),
    coalesce(
      nullif(legacy.metadata->>'net_value', '')::numeric,
      nullif(legacy.metadata->>'value', '')::numeric
        - coalesce(nullif(legacy.metadata->>'mortgage', '')::numeric, 0)
    ),
    coalesce(
      nullif(legacy.metadata->>'net_value', '')::numeric,
      nullif(legacy.metadata->>'value', '')::numeric
        - coalesce(nullif(legacy.metadata->>'mortgage', '')::numeric, 0)
    ),
    'property_value_less_mortgage', 365, legacy.updated_at
  FROM LATERAL (
    SELECT legacy.*
    FROM entities legacy
    JOIN entity_types legacy_type ON legacy_type.id = legacy.entity_type_id
    WHERE legacy.organization_id = :'org_id'
      AND legacy_type.slug = 'asset'
      AND legacy.deleted_at IS NULL
      AND lower(legacy.name) LIKE '%camden%'
    ORDER BY legacy.updated_at DESC, legacy.id DESC LIMIT 1
  ) legacy
), inserted AS (
  INSERT INTO events (
    organization_id, origin_id, title, payload_type, payload_text,
    semantic_type, occurred_at, created_at, metadata
  )
  SELECT
    :'org_id', 'net-worth-component:' || component_key, title, 'text', title,
    'observation', occurred_at, now(),
    jsonb_build_object(
      'schema', 'net-worth-component/v1',
      'component_key', component_key,
      'source', source,
      'institution', institution,
      'account_key', account_key,
      'account_type', account_type,
      'asset_class', asset_class,
      'currency', currency,
      'value', value,
      'value_low', value_low,
      'value_high', value_high,
      'valuation_basis', valuation_basis,
      'freshness_days', freshness_days,
      'status', 'active'
    )
  FROM components
  WHERE value IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events current
      WHERE current.organization_id = :'org_id'
        AND current.semantic_type = 'observation'
        AND current.superseded_by IS NULL
        AND current.metadata->>'schema' = 'net-worth-component/v1'
        AND current.metadata->>'component_key' = components.component_key
    )
  RETURNING id
)
SELECT count(*) AS normalized_components_created FROM inserted;

WITH required(component_key) AS (VALUES
    ('revolut-current-gbp'),
    ('revolut-current-usd'),
    ('chase-cash'),
    ('trading212-investment'),
    ('retirement-policy'),
    ('qnb-eurobond'),
    ('binance'),
    ('refine-angel-investment'),
    ('kartal-property'),
    ('izmit-property'),
    ('kartepe-property'),
    ('camden-property-equity')
)
SELECT required.component_key AS missing_required_component
FROM required
WHERE NOT EXISTS (
    SELECT 1 FROM events current
    WHERE current.organization_id = :'org_id'
      AND current.semantic_type = 'observation'
      AND current.superseded_by IS NULL
      AND current.metadata->>'schema' = 'net-worth-component/v1'
      AND current.metadata->>'component_key' = required.component_key
  );

WITH required(component_key) AS (VALUES
    ('revolut-current-gbp'), ('revolut-current-usd'), ('chase-cash'),
    ('trading212-investment'), ('retirement-policy'), ('qnb-eurobond'),
    ('binance'), ('refine-angel-investment'), ('kartal-property'),
    ('izmit-property'), ('kartepe-property'), ('camden-property-equity')
), missing AS (
  SELECT 1
  FROM required
  WHERE NOT EXISTS (
    SELECT 1 FROM events current
    WHERE current.organization_id = :'org_id'
      AND current.semantic_type = 'observation'
      AND current.superseded_by IS NULL
      AND current.metadata->>'schema' = 'net-worth-component/v1'
      AND current.metadata->>'component_key' = required.component_key
  )
)
SELECT 1 / CASE WHEN count(*) = 0 THEN 1 ELSE 0 END
  AS all_required_components_present
FROM missing;

INSERT INTO entities (
  organization_id, entity_type_id, name, slug, metadata, created_by,
  created_at, updated_at
)
SELECT
  :'org_id', :'account_type_id', 'Revolut', 'revolut',
  jsonb_build_object(
    'institution', 'Revolut',
    'account_type', 'current',
    'is_active', true,
    'aliases', coalesce(legacy.metadata->'aliases', '[]'::jsonb)
  ),
  (SELECT "userId" FROM member WHERE "organizationId" = :'org_id' ORDER BY "createdAt" LIMIT 1),
  now(), now()
FROM entities legacy
JOIN entity_types legacy_type ON legacy_type.id = legacy.entity_type_id
WHERE legacy.organization_id = :'org_id'
  AND legacy_type.slug = 'asset'
  AND legacy.deleted_at IS NULL
  AND lower(legacy.name) = 'revolut'
  AND NOT EXISTS (
    SELECT 1 FROM entities current
    WHERE current.organization_id = :'org_id'
      AND current.entity_type_id = :'account_type_id'
      AND current.slug = 'revolut'
      AND current.deleted_at IS NULL
  )
ORDER BY legacy.updated_at DESC, legacy.id DESC
LIMIT 1;

UPDATE entities current
SET metadata = jsonb_set(
      coalesce(current.metadata, '{}'::jsonb),
      '{aliases}',
      coalesce(legacy.metadata->'aliases', '[]'::jsonb)
    ),
    updated_at = now()
FROM LATERAL (
  SELECT legacy.metadata
  FROM entities legacy
  JOIN entity_types legacy_type ON legacy_type.id = legacy.entity_type_id
  WHERE legacy.organization_id = :'org_id'
    AND legacy_type.slug = 'asset'
    AND legacy.deleted_at IS NULL
    AND lower(legacy.name) = 'revolut'
  ORDER BY legacy.updated_at DESC, legacy.id DESC
  LIMIT 1
) legacy
WHERE current.organization_id = :'org_id'
  AND current.entity_type_id = :'account_type_id'
  AND current.slug = 'revolut'
  AND current.deleted_at IS NULL;

UPDATE entities legacy
SET deleted_at = now(), updated_at = now()
FROM entity_types legacy_type
WHERE legacy.entity_type_id = legacy_type.id
  AND legacy.organization_id = :'org_id'
  AND legacy_type.slug = 'asset'
  AND legacy.deleted_at IS NULL;

COMMIT;
