-- migrate:up

-- Migrate `founder` entities in the `market` org to `$member` entities so
-- the identity engine can adopt them on OAuth sign-in.
--
-- Rationale: the engine binds a signing-in user to an existing `$member` by
-- multi-namespace identity lookup (email, linkedin_url, github_username,
-- etc.). Pre-curated founders need to BE `$member` rows for that adoption
-- to fire. Keeping `founder` as a separate type means the engine can never
-- bind a user to their pre-curated profile.
--
-- The post-migration shape:
--   - `$member` entities in market carry the founder's metadata, including
--     `metadata.role='founder'` so the public browse route in
--     `lobu-ai/lobu-web` can filter `$member` rows on role.
--   - `entity_identities` rows are written for every namespace value the
--     migration can extract (email, linkedin_url, twitter_handle).
--   - Existing relationship rows (`works_at`, `founded`, `previously_at`,
--     `educated_at`, etc.) are re-pointed from founder.id to the new
--     $member.id.
--   - Relationship-type rules are widened to accept `$member` as the
--     source slug for the relationships that pointed at founders.
--   - Source `founder` rows are soft-deleted (deleted_at=NOW()) — kept for
--     audit history; the application path filters them out.
--
-- Idempotent: each step uses ON CONFLICT / WHERE NOT EXISTS, so a re-run
-- on a partially-migrated DB completes the unfinished work without
-- duplicating rows. Safe to run on a fresh DB (no founders yet) — every
-- query returns the empty set.

DO $$
DECLARE
    v_market_org_id text;
    v_market_org_slug text;
    v_member_type_id integer;
    v_founder_type_id integer;
BEGIN
    FOR v_market_org_id, v_market_org_slug IN
        SELECT id, slug
        FROM public.organization
        WHERE slug IN ('market', 'venture-capital')
        ORDER BY CASE slug WHEN 'market' THEN 0 ELSE 1 END
    LOOP
        RAISE NOTICE 'running founder→$member migration for org %', v_market_org_slug;

    SELECT id INTO v_member_type_id
    FROM public.entity_types
    WHERE organization_id = v_market_org_id AND slug = '$member' AND deleted_at IS NULL
    LIMIT 1;
    IF v_member_type_id IS NULL THEN
        INSERT INTO public.entity_types (organization_id, slug, name, created_at, updated_at)
        VALUES (v_market_org_id, '$member', 'Member', NOW(), NOW())
        RETURNING id INTO v_member_type_id;
    END IF;

    SELECT id INTO v_founder_type_id
    FROM public.entity_types
    WHERE organization_id = v_market_org_id AND slug = 'founder' AND deleted_at IS NULL
    LIMIT 1;

    IF v_founder_type_id IS NULL THEN
        RAISE NOTICE 'no founder entity_type in % — nothing to migrate', v_market_org_slug;
        CONTINUE;
    END IF;

    -- 1. Create $member rows for each founder. Idempotent via slug uniqueness:
    --    we generate a deterministic slug derived from the founder id so a
    --    re-run without source data still produces the same slug.
    INSERT INTO public.entities (
        name, slug, entity_type_id, organization_id, parent_id,
        metadata, created_by, created_at, updated_at
    )
    SELECT
        f.name,
        'member-from-founder-' || f.id::text AS slug,
        v_member_type_id,
        v_market_org_id,
        NULL,
        COALESCE(f.metadata, '{}'::jsonb) || jsonb_build_object('role', 'founder', 'migrated_from_founder_id', f.id),
        COALESCE(f.created_by, 'system'),
        NOW(),
        NOW()
    FROM public.entities f
    WHERE f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.entities m
          WHERE m.organization_id = v_market_org_id
            AND m.entity_type_id = v_member_type_id
            AND m.metadata->>'migrated_from_founder_id' = f.id::text
            AND m.deleted_at IS NULL
      );

    -- 2. Write entity_identities rows for any namespace values present on
    -- the founder metadata. Limited to the namespaces the engine consults.
    --    email, linkedin_url, twitter_handle.
    INSERT INTO public.entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
    )
    SELECT
        v_market_org_id,
        m.id,
        'email',
        LOWER(f.metadata->>'email'),
        'migration:founder_to_member'
    FROM public.entities m
    JOIN public.entities f
      ON f.id = (m.metadata->>'migrated_from_founder_id')::bigint
    WHERE m.organization_id = v_market_org_id
      AND m.entity_type_id = v_member_type_id
      AND m.deleted_at IS NULL
      AND f.metadata ? 'email'
      AND f.metadata->>'email' IS NOT NULL
      AND f.metadata->>'email' <> ''
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO NOTHING;

    INSERT INTO public.entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
    )
    SELECT
        v_market_org_id,
        m.id,
        'linkedin_url',
        f.metadata->>'linkedin_url',
        'migration:founder_to_member'
    FROM public.entities m
    JOIN public.entities f
      ON f.id = (m.metadata->>'migrated_from_founder_id')::bigint
    WHERE m.organization_id = v_market_org_id
      AND m.entity_type_id = v_member_type_id
      AND m.deleted_at IS NULL
      AND f.metadata ? 'linkedin_url'
      AND f.metadata->>'linkedin_url' IS NOT NULL
      AND f.metadata->>'linkedin_url' <> ''
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO NOTHING;

    INSERT INTO public.entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
    )
    SELECT
        v_market_org_id,
        m.id,
        'twitter_handle',
        LOWER(REPLACE(f.metadata->>'twitter_handle', '@', '')),
        'migration:founder_to_member'
    FROM public.entities m
    JOIN public.entities f
      ON f.id = (m.metadata->>'migrated_from_founder_id')::bigint
    WHERE m.organization_id = v_market_org_id
      AND m.entity_type_id = v_member_type_id
      AND m.deleted_at IS NULL
      AND f.metadata ? 'twitter_handle'
      AND f.metadata->>'twitter_handle' IS NOT NULL
      AND f.metadata->>'twitter_handle' <> ''
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO NOTHING;

    -- 3. Re-point existing relationships pointing FROM the founder rows to
    -- point FROM the new $member rows. The reverse direction (relationships
    -- pointing AT founders) is handled symmetrically. If the destination edge
    -- already exists, archive the founder edge first so the live-triple unique
    -- index remains satisfied.
    UPDATE public.entity_relationships r
    SET deleted_at = NOW(), updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE r.from_entity_id = f.id
      AND r.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL
      AND EXISTS (
          SELECT 1
          FROM public.entity_relationships existing
          WHERE existing.from_entity_id = m.id
            AND existing.to_entity_id = r.to_entity_id
            AND existing.relationship_type_id = r.relationship_type_id
            AND existing.deleted_at IS NULL
            AND existing.id <> r.id
      );

    UPDATE public.entity_relationships r
    SET from_entity_id = m.id, updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE r.from_entity_id = f.id
      AND r.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL;

    UPDATE public.entity_relationships r
    SET deleted_at = NOW(), updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE r.to_entity_id = f.id
      AND r.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL
      AND EXISTS (
          SELECT 1
          FROM public.entity_relationships existing
          WHERE existing.from_entity_id = r.from_entity_id
            AND existing.to_entity_id = m.id
            AND existing.relationship_type_id = r.relationship_type_id
            AND existing.deleted_at IS NULL
            AND existing.id <> r.id
      );

    UPDATE public.entity_relationships r
    SET to_entity_id = m.id, updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE r.to_entity_id = f.id
      AND r.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL;

    -- 4. Widen relationship_type rules to accept `$member` as a source
    -- where they previously accepted `founder`. Keep both slugs for now —
    -- if the founder slug ever resurrects (e.g. for catalog imports that
    -- still emit the old type), the rules tolerate it.
    INSERT INTO public.entity_relationship_type_rules (
        relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
    )
    SELECT DISTINCT r.relationship_type_id, '$member', r.target_entity_type_slug, NOW()
    FROM public.entity_relationship_type_rules r
    JOIN public.entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.source_entity_type_slug = 'founder'
      AND rt.organization_id = v_market_org_id
      AND NOT EXISTS (
          SELECT 1 FROM public.entity_relationship_type_rules existing
          WHERE existing.relationship_type_id = r.relationship_type_id
            AND existing.source_entity_type_slug = '$member'
            AND existing.target_entity_type_slug = r.target_entity_type_slug
      );

    INSERT INTO public.entity_relationship_type_rules (
        relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
    )
    SELECT DISTINCT r.relationship_type_id, r.source_entity_type_slug, '$member', NOW()
    FROM public.entity_relationship_type_rules r
    JOIN public.entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.target_entity_type_slug = 'founder'
      AND rt.organization_id = v_market_org_id
      AND NOT EXISTS (
          SELECT 1 FROM public.entity_relationship_type_rules existing
          WHERE existing.relationship_type_id = r.relationship_type_id
            AND existing.source_entity_type_slug = r.source_entity_type_slug
            AND existing.target_entity_type_slug = '$member'
      );

    -- 5. Repoint any pre-existing entity_identities rows that pointed at
    -- a founder. Step 2 wrote *new* identity rows for the $member, but if
    -- some other path had already written identity rows on the founder
    -- (e.g. an earlier provisioning script), those would dangle once the
    -- founder is soft-deleted in step 7 — entity-identity lookups join on
    -- entities.deleted_at IS NULL and silently miss the binding.
    UPDATE public.entity_identities ei
    SET deleted_at = NOW(), updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE ei.entity_id = f.id
      AND ei.organization_id = v_market_org_id
      AND ei.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND EXISTS (
          SELECT 1
          FROM public.entity_identities existing
          WHERE existing.organization_id = ei.organization_id
            AND existing.namespace = ei.namespace
            AND existing.identifier = ei.identifier
            AND existing.entity_id = m.id
            AND existing.deleted_at IS NULL
            AND existing.id <> ei.id
      );

    UPDATE public.entity_identities ei
    SET entity_id = m.id, updated_at = NOW()
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE ei.entity_id = f.id
      AND ei.organization_id = v_market_org_id
      AND ei.deleted_at IS NULL
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id;

    -- 6. Rewrite event.entity_ids arrays so historical events on founder
    -- rows resolve to the corresponding $member going forward. array_replace
    -- is a no-op on a re-run because after the first pass the founder id is
    -- gone from the array and the WHERE filter excludes the row.
    UPDATE public.events e
    SET entity_ids = array_replace(e.entity_ids, f.id, m.id)
    FROM public.entities f
    JOIN public.entities m
      ON m.organization_id = f.organization_id
     AND m.entity_type_id = v_member_type_id
     AND m.metadata->>'migrated_from_founder_id' = f.id::text
     AND m.deleted_at IS NULL
    WHERE e.entity_ids @> ARRAY[f.id]
      AND e.organization_id = v_market_org_id
      AND f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id;

    -- 7. Soft-delete the source founder rows. Audit trail survives in the
    -- entities table itself; queries already filter `deleted_at IS NULL`.
    UPDATE public.entities f
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE f.organization_id = v_market_org_id
      AND f.entity_type_id = v_founder_type_id
      AND f.deleted_at IS NULL
      AND EXISTS (
          SELECT 1 FROM public.entities m
          WHERE m.organization_id = v_market_org_id
            AND m.entity_type_id = v_member_type_id
            AND m.metadata->>'migrated_from_founder_id' = f.id::text
            AND m.deleted_at IS NULL
      );
    END LOOP;
END $$;


-- migrate:down

-- Fail loudly. A bare `SELECT 1` would let an automatic rollback (CI,
-- incident response, dbmate down) succeed silently while leaving the DB
-- in the migrated state, masking the irreversibility. Operators wanting
-- to revert run a manual playbook: clear deleted_at on the founder rows,
-- re-point relationships using `metadata.migrated_from_founder_id`, then
-- delete the new $member rows.
DO $$
BEGIN
    RAISE EXCEPTION 'irreversible: founder→$member is a one-way data migration. Reverse by manual playbook only.';
END $$;
