-- Seed currency aliases on the Revolut account assets.
--
-- The `asset` entity type declares governed spend metrics whose `transactions`
-- eventSet resolves each transaction to an account by matching the
-- transaction's `currency` against the asset's `metadata.aliases`. Aliases are
-- ENTITY DATA, not schema, so `lobu apply` does not set them — run this once
-- (per environment) after the assets exist.
--
-- Idempotent: re-running sets the same aliases. Only ONE asset may own a given
-- currency code, or transactions in that currency would resolve to (and be
-- counted by) more than one account. The savings account is therefore NOT
-- aliased 'GBP'; its flows are TRANSFER and excluded from card spend anyway.
--
-- Scope to the buremba org if running against a shared database.
UPDATE entities SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{aliases}', '["GBP"]'::jsonb)
  WHERE entity_type = 'asset' AND name = 'Revolut GBP';
UPDATE entities SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{aliases}', '["USD"]'::jsonb)
  WHERE entity_type = 'asset' AND name = 'Revolut USD';
UPDATE entities SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{aliases}', '["EUR"]'::jsonb)
  WHERE entity_type = 'asset' AND name = 'Revolut EUR';
UPDATE entities SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{aliases}', '["VND"]'::jsonb)
  WHERE entity_type = 'asset' AND name = 'Revolut VND';
