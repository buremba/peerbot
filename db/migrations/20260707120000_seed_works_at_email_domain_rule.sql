-- migrate:up

-- Seed the `works_at` auto_create_when rule on every public catalog org.
--
-- The identity engine (packages/server/src/identity/engine.ts) derives a
-- relationship edge when a person-fact's normalized value equals a catalog
-- entity's `metadata->>targetField`. This migration wires the canonical
-- employment inference:
--
--   person fact  email_domain = "acme.com"
--   catalog company  metadata.domain = "acme.com"
--   ⇒ derive  person --works_at--> company
--
-- The `email_domain` fact is derived centrally by the engine from every
-- `email` fact (see deriveCompanionFacts), so this fires for any connector
-- that produces an email — not just Google Workspace `hd` sign-ins.
--
-- Two things must be true for the engine to act (both seeded here, per
-- public-catalog org that has a `company` type):
--   1. `company.domain` is declared `x-identity-namespace: true` in the type's
--      metadata_schema — engine.ts:findEntitiesByMetadataField refuses to match
--      an undeclared field.
--   2. an active `works_at` relationship type carries the compiled rule blob
--      { autoCreateWhen, ruleVersion, ruleHash } in `metadata`.
--
-- ruleHash below is sha256 of the canonicalised rule set, matching
-- ruleHashFor() in packages/server/src/identity/rules.ts. It is validated at
-- read time by loadRules(): if this hash ever disagrees with a fresh hash of
-- the stored rules (e.g. the canonicaliser changes), the engine SKIPS the rule
-- and logs drift rather than acting on a stale rule — so a mistake here fails
-- safe (no derivations), never wrong. If the rule set is edited, recompute the
-- hash with ruleHashFor and reseed.
--
-- assuranceRequired = 'oauth_verified': only provider-verified emails derive an
-- edge. A self-attested or scraped contact email will not create a works_at,
-- and a personal @gmail.com never matches a company (gmail.com is not a
-- company domain), so false "works at Google" edges are avoided by design.
--
-- matchStrategy = 'unique_only': if two catalog companies share a domain the
-- engine records a collision event for human resolution instead of guessing.

DO $$
DECLARE
  org RECORD;
  company_type RECORD;
  schema jsonb;
  props jsonb;
  domain_prop jsonb;
  rule_metadata jsonb;
BEGIN
  rule_metadata := jsonb_build_object(
    'autoCreateWhen', jsonb_build_array(
      jsonb_build_object(
        'sourceNamespace', 'email_domain',
        'targetField', 'domain',
        'assuranceRequired', 'oauth_verified',
        'matchStrategy', 'unique_only'
      )
    ),
    'ruleVersion', 1,
    'ruleHash', 'db3256f51ec866accb213b0167068f2f4df32e55b4bd5eb83067d27a157c7419'
  );

  FOR org IN
    SELECT id FROM organization WHERE visibility = 'public'
  LOOP
    -- Only orgs that actually model companies get the rule/field.
    SELECT id, metadata_schema INTO company_type
    FROM entity_types
    WHERE organization_id = org.id
      AND slug = 'company'
      AND deleted_at IS NULL
    LIMIT 1;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- 1. Declare company.domain as an identity-matchable field, preserving any
    --    existing schema/props. Only ADD the marker when it is absent — an
    --    existing x-identity-namespace value (true OR the richer object form the
    --    engine also accepts) is left untouched, so a reseed never downgrades a
    --    hand-tuned declaration. Idempotent: with the marker present this is a
    --    no-op on that key.
    schema := COALESCE(company_type.metadata_schema, '{"type":"object"}'::jsonb);
    props := COALESCE(schema -> 'properties', '{}'::jsonb);
    domain_prop := COALESCE(props -> 'domain', '{"type":"string"}'::jsonb);
    IF NOT (domain_prop ? 'x-identity-namespace') THEN
      domain_prop := domain_prop || '{"x-identity-namespace": true}'::jsonb;
      props := props || jsonb_build_object('domain', domain_prop);
      schema := schema || jsonb_build_object('properties', props);
      UPDATE entity_types
      SET metadata_schema = schema, updated_at = now()
      WHERE id = company_type.id;
    END IF;

    -- 2. Upsert the works_at type carrying the compiled rule. Idempotent on the
    --    active (organization_id, slug) unique index; on conflict we MERGE the
    --    rule keys into any existing metadata (never clobber other fields on an
    --    already-defined works_at type) so a reseed corrects drift in place.
    INSERT INTO entity_relationship_types (
      organization_id, slug, name, description, is_symmetric, status, metadata,
      created_at, updated_at
    ) VALUES (
      org.id, 'works_at', 'Works at',
      'Person is employed by / affiliated with a company. Auto-derived when the person''s email domain matches the company''s domain.',
      false, 'active', rule_metadata, now(), now()
    )
    ON CONFLICT (organization_id, slug) WHERE (status = 'active')
    DO UPDATE SET
      metadata = COALESCE(entity_relationship_types.metadata, '{}'::jsonb) || rule_metadata,
      updated_at = now();
  END LOOP;
END $$;

-- migrate:down

-- Remove the seeded rule; leave the x-identity-namespace marker on
-- company.domain in place (harmless without a rule, and other rules may rely
-- on it). Only strip the works_at rule metadata we added.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN
    SELECT id FROM organization WHERE visibility = 'public'
  LOOP
    UPDATE entity_relationship_types
    SET metadata = metadata - 'autoCreateWhen' - 'ruleVersion' - 'ruleHash',
        updated_at = now()
    WHERE organization_id = org.id
      AND slug = 'works_at'
      AND status = 'active'
      AND metadata ->> 'ruleHash' = 'db3256f51ec866accb213b0167068f2f4df32e55b4bd5eb83067d27a157c7419';
  END LOOP;
END $$;
