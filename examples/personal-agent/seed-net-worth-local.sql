-- Realistic, idempotent local fixture for the weekly net-worth Behavior.
-- Usage after applying this project to the disposable local org:
--   psql "$DATABASE_URL" -v ORG_SLUG=local-install -f seed-net-worth-local.sql
--
-- Rows are append-only and tagged with seed=net-worth-v3. Re-running does not
-- delete or duplicate them. This deliberately includes superseded, forked, and
-- orphaned source identities so the reaction's current-row policy is exercised.

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

SELECT id AS midas_connection_id
FROM connections
WHERE organization_id = :'org_id'
  AND slug = 'midas'
  AND status = 'active'
LIMIT 1
\gset

SELECT id AS revolut_connection_id
FROM connections
WHERE organization_id = :'org_id'
  AND slug = 'revolut-buremba'
  AND status = 'active'
LIMIT 1
\gset

INSERT INTO connections (
  organization_id, connector_key, display_name, status, slug, created_at,
  updated_at
)
SELECT
  :'org_id', 'midas', 'Midas reconnect fixture', 'active',
  'seed-midas-reconnected', now() - interval '8 days', now()
WHERE NOT EXISTS (
  SELECT 1 FROM connections
  WHERE organization_id = :'org_id' AND slug = 'seed-midas-reconnected'
);

SELECT id AS fork_connection_id
FROM connections
WHERE organization_id = :'org_id' AND slug = 'seed-midas-reconnected'
LIMIT 1
\gset

-- A normal resync chain: only the newer row remains in current_event_records.
INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, metadata
)
SELECT
  :'org_id', 'midas-holding-US-AAPL', 'financial_asset', 'midas',
  :'midas_connection_id', 'AAPL old resync version', now() - interval '15 days',
  now() - interval '15 days',
  '{"seed":"net-worth-v3","seed_key":"midas-aapl-old","symbol":"AAPL","type":"US","shares":1,"price":190,"avg_cost":160,"value":190,"currency":"USD","status":"active"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-old'
);

SELECT id AS old_aapl_id
FROM events
WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-old'
LIMIT 1
\gset

INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, supersedes_event_id, metadata
)
SELECT
  :'org_id', 'midas-holding-US-AAPL', 'financial_asset', 'midas',
  :'midas_connection_id', 'AAPL current primary version', now() - interval '8 days',
  now() - interval '8 days', :'old_aapl_id',
  '{"seed":"net-worth-v3","seed_key":"midas-aapl-current","symbol":"AAPL","type":"US","shares":2,"price":220,"avg_cost":160,"value":440,"currency":"USD","status":"active"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-current'
);

SELECT id AS current_aapl_id
FROM events
WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-current'
LIMIT 1
\gset

UPDATE events
SET superseded_by = :'current_aapl_id'
WHERE id = :'old_aapl_id' AND superseded_by IS NULL;

-- Same source identity on a live reconnect. It is inserted later, so the
-- weekly write-time deduper selects it once rather than summing both books.
INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, metadata
)
SELECT
  :'org_id', 'midas-holding-US-AAPL', 'financial_asset', 'midas',
  :'fork_connection_id', 'AAPL duplicate reconnect version', now() - interval '8 days',
  now() - interval '7 days 23 hours',
  '{"seed":"net-worth-v3","seed_key":"midas-aapl-fork","symbol":"AAPL","type":"US","shares":2,"price":220,"avg_cost":160,"value":440,"currency":"USD","status":"active"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-fork'
);

-- Post-connection-deletion shape. The active-connection join must exclude it.
INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, metadata
)
SELECT
  :'org_id', 'midas-holding-US-AAPL', 'financial_asset', 'midas', NULL,
  'AAPL orphaned duplicate', now() - interval '1 hour', now() - interval '1 hour',
  '{"seed":"net-worth-v3","seed_key":"midas-aapl-orphan","symbol":"AAPL","type":"US","shares":999,"price":999,"avg_cost":1,"value":998001,"currency":"USD","status":"active"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id' AND metadata->>'seed_key' = 'midas-aapl-orphan'
);

INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, metadata
)
SELECT :'org_id', source.origin_id, 'financial_asset', 'midas', :'midas_connection_id',
  source.payload_text, source.occurred_at, source.created_at, source.metadata
FROM (VALUES
  ('midas-holding-US-LOBUNOQUOTE999', 'Missing quote broker fallback', now() - interval '8 days', now() - interval '7 days 22 hours',
   '{"seed":"net-worth-v3","seed_key":"midas-noquote","symbol":"LOBUNOQUOTE999","type":"US","shares":2,"price":25,"avg_cost":20,"value":50,"currency":"USD","status":"active"}'::jsonb),
  ('midas-holding-TR-GARAN', 'TRY position', now() - interval '8 days', now() - interval '7 days 21 hours',
   '{"seed":"net-worth-v3","seed_key":"midas-garan","symbol":"GARAN","type":"TR","shares":10,"price":120,"avg_cost":90,"value":1200,"currency":"TRY","status":"active"}'::jsonb),
  ('midas-holding-US-SOLD', 'Closed position', now() - interval '8 days', now() - interval '7 days 20 hours',
   '{"seed":"net-worth-v3","seed_key":"midas-sold-closed","symbol":"SOLD","type":"US","shares":0,"price":0,"avg_cost":40,"value":0,"currency":"GBP","status":"closed"}'::jsonb)
) AS source(origin_id, payload_text, occurred_at, created_at, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id'
    AND metadata->>'seed_key' = source.metadata->>'seed_key'
);

INSERT INTO events (
  organization_id, origin_id, semantic_type, connector_key, connection_id,
  payload_text, occurred_at, created_at, metadata
)
SELECT :'org_id', source.origin_id, source.semantic_type, 'revolut',
  :'revolut_connection_id', source.payload_text, now() - interval '1 day',
  source.created_at, source.metadata
FROM (VALUES
  ('revolut-investment-position-gbp-isa-VUAG', 'VUAG position', 'investment_position', now() - interval '23 hours',
   '{"seed":"net-worth-v3","seed_key":"revolut-vuag","portfolio_id":"gbp-isa","account_type":"Stocks & Shares ISA","ref":"VUAG","ticker":"VUAG","instrument_type":"ETF","quantity":10,"current_price":100,"price_currency":"GBP","value":1000,"value_currency":"GBP","allocation":0.833333}'::jsonb),
  ('revolut-investment-portfolio-gbp-isa', 'GBP portfolio', 'investment_balance', now() - interval '22 hours',
   '{"seed":"net-worth-v3","seed_key":"revolut-gbp-balance","portfolio_id":"gbp-isa","account_type":"Stocks & Shares ISA","balance":1200,"currency":"GBP","cash_balance":200,"position_count":1}'::jsonb),
  ('revolut-investment-position-us-brokerage-SCHD', 'SCHD position', 'investment_position', now() - interval '21 hours',
   '{"seed":"net-worth-v3","seed_key":"revolut-schd","portfolio_id":"us-brokerage","account_type":"Brokerage","ref":"SCHD","ticker":"SCHD","instrument_type":"ETF","quantity":5,"current_price":90,"price_currency":"USD","value":450,"value_currency":"USD","allocation":0.9}'::jsonb),
  ('revolut-investment-portfolio-us-brokerage', 'USD portfolio', 'investment_balance', now() - interval '20 hours',
   '{"seed":"net-worth-v3","seed_key":"revolut-usd-balance","portfolio_id":"us-brokerage","account_type":"Brokerage","balance":500,"currency":"USD","cash_balance":50,"position_count":1}'::jsonb)
) AS source(origin_id, payload_text, semantic_type, created_at, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id'
    AND metadata->>'seed_key' = source.metadata->>'seed_key'
);

-- A prior immutable snapshot supplies the t0 side for real reaction attribution.
INSERT INTO events (
  organization_id, title, payload_type, payload_text, semantic_type,
  occurred_at, created_at, metadata
)
SELECT
  :'org_id', 'Net worth seed baseline', 'markdown',
  'Seeded prior consolidated investment baseline.', 'summary',
  now() - interval '7 days', now() - interval '7 days',
  jsonb_build_object(
    'seed', 'net-worth-v3',
    'seed_key', 'net-worth-prior-snapshot',
    'version', 3,
    'schema', 'net-worth-snapshot/v3',
    'week', to_char(now() - interval '7 days', 'IYYY-"W"IW'),
    'calculated_at', to_char(now() - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'base_currency', 'GBP',
    'scope', 'connected_investments_only',
    'net_worth_gbp', 1342.50,
    'positions', jsonb_build_array(
      jsonb_build_object('position_key','midas:midas-holding-US-AAPL','source','midas','account_key','midas-investments','asset_class','security','native_currency','USD','quantity',1,'native_price',220,'fx_to_gbp',0.75,'value_gbp',165,'value_gbp_pence',16500),
      jsonb_build_object('position_key','midas:midas-holding-US-LOBUNOQUOTE999','source','midas','account_key','midas-investments','asset_class','security','native_currency','USD','quantity',2,'native_price',25,'fx_to_gbp',0.75,'value_gbp',37.5,'value_gbp_pence',3750),
      jsonb_build_object('position_key','midas:midas-holding-US-SOLD','source','midas','account_key','midas-investments','asset_class','security','native_currency','GBP','quantity',1,'native_price',40,'fx_to_gbp',1,'value_gbp',40,'value_gbp_pence',4000),
      jsonb_build_object('position_key','revolut:revolut-investment-position-gbp-isa-VUAG','source','revolut','account_key','revolut:gbp-isa','asset_class','etf','native_currency','GBP','quantity',10,'native_price',95,'fx_to_gbp',1,'value_gbp',950,'value_gbp_pence',95000),
      jsonb_build_object('position_key','revolut:revolut-investment-portfolio-gbp-isa:cash:GBP','source','revolut','account_key','revolut:gbp-isa','asset_class','cash','native_currency','GBP','quantity',150,'native_price',1,'fx_to_gbp',1,'value_gbp',150,'value_gbp_pence',15000)
    ),
    'sources', '[]'::jsonb,
    'fx', '[]'::jsonb,
    'breakdowns', '{}'::jsonb,
    'attribution', '{}'::jsonb,
    'attribution_positions', '[]'::jsonb
  )
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE organization_id = :'org_id'
    AND metadata->>'seed_key' = 'net-worth-prior-snapshot'
);

COMMIT;

SELECT
  metadata->>'seed_key' AS seed_key,
  semantic_type,
  connector_key,
  origin_id,
  superseded_by
FROM events
WHERE organization_id = :'org_id' AND metadata->>'seed' = 'net-worth-v3'
ORDER BY id;
