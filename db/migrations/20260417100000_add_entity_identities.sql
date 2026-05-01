-- migrate:up

-- Normalized identifier store. One row per (organization_id, namespace, identifier).
-- Replaces the earlier scheme of storing identifiers inside entities.metadata JSONB
-- arrays. The UNIQUE constraint is the foundation of the whole design:
--   * creation races collapse on the UNIQUE (one batch wins, the other links)
--   * cross-entity contamination is constraint-blocked
--   * accrete is just INSERT ... ON CONFLICT DO NOTHING
--   * lookup is a plain BTREE seek (no GIN-on-jsonb)
CREATE TABLE public.entity_identities (
    id bigserial PRIMARY KEY,
    organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
    entity_id bigint NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
    namespace text NOT NULL,
    identifier text NOT NULL,
    source_connector text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

-- Relaxed uniqueness: only live rows are constrained, so soft-delete + re-claim
-- is a supported repair path (mis-attribution recovery).
CREATE UNIQUE INDEX idx_entity_identities_live_unique
    ON public.entity_identities (organization_id, namespace, identifier)
    WHERE deleted_at IS NULL;

-- Primary ingestion lookup path: "does anyone in this org own this identifier?"
CREATE INDEX idx_entity_identities_lookup
    ON public.entity_identities (organization_id, namespace, identifier)
    WHERE deleted_at IS NULL;

-- Reverse lookup: "what identifiers does this entity have?"
CREATE INDEX idx_entity_identities_by_entity
    ON public.entity_identities (entity_id)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE public.entity_identities IS
    'Normalized identifier claims per entity. See docs/identity-linking.md for the full pattern.';
COMMENT ON COLUMN public.entity_identities.namespace IS
    'Identifier kind. Standard values: phone, email, wa_jid, slack_user_id, github_login, auth_user_id, google_contact_id. Custom namespaces allowed but connectors sharing a namespace must agree on its format.';
COMMENT ON COLUMN public.entity_identities.identifier IS
    'Normalized identifier value (E.164 digits for phone, lowercase for email, etc.). Normalizers in @lobu/connector-sdk own the canonical form.';
COMMENT ON COLUMN public.entity_identities.source_connector IS
    'Who claimed this identifier: "connector:whatsapp", "manual", or null when seeded by migration.';


-- Per-install override surface. A JSONB keyed by entityType; shallow-merged
-- onto the connector's declared entityLinks at rule-resolve time. Lets an
-- org retarget, disable rules, flip autoCreate, or mask specific identities
-- without forking the connector. Null column = use connector defaults verbatim.
ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS entity_link_overrides jsonb;

COMMENT ON COLUMN public.connector_definitions.entity_link_overrides IS
    'Per-install override of connector entityLinks rules. See resolveEntityLinkRules() for merge semantics.';


-- The old scalar-JSONB index was built for a shape (entities.metadata->>wa_jid)
-- we no longer use — identifiers now live in entity_identities. Drop to avoid
-- carrying an unused index and a misleading comment on future reads.
DROP INDEX IF EXISTS public.idx_entities_wa_jid;


-- migrate:down

DROP INDEX IF EXISTS public.idx_entity_identities_by_entity;
DROP INDEX IF EXISTS public.idx_entity_identities_lookup;
DROP INDEX IF EXISTS public.idx_entity_identities_live_unique;
DROP TABLE IF EXISTS public.entity_identities;

ALTER TABLE public.connector_definitions
    DROP COLUMN IF EXISTS entity_link_overrides;

CREATE INDEX IF NOT EXISTS idx_entities_wa_jid
    ON public.entities (entity_type, (metadata->>'wa_jid'))
    WHERE metadata ? 'wa_jid' AND deleted_at IS NULL;
