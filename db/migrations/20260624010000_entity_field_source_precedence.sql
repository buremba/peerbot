-- migrate:up

-- Source precedence for entity-field projection. The grained projection folded
-- purely keep-greater-by-observation_id, so a later agent/system write silently
-- clobbered an earlier HUMAN correction. Add a source rank (user > agent > system)
-- so a correction sticks: lower rank wins; ties (same source) fall back to
-- keep-greater by observation_id. `source` rides on the entity_field event
-- metadata (emitEntityFieldEvent); existing rows default to agent rank (2).

ALTER TABLE public.entity_field_state
    ADD COLUMN IF NOT EXISTS source_rank bigint NOT NULL DEFAULT 2;

CREATE OR REPLACE FUNCTION public.project_entity_field() RETURNS trigger AS $$
DECLARE
    v_entity_id bigint;
    v_field text;
    v_mutation text;
    v_rank bigint;
BEGIN
    IF coalesce(NEW.metadata->>'entity_id', '') !~ '^[0-9]{1,18}$'
       OR coalesce(NEW.metadata->>'field_path', '') = '' THEN
        RETURN NEW;  -- not a field-grained entity edit: skip
    END IF;
    v_entity_id := (NEW.metadata->>'entity_id')::bigint;
    v_field := NEW.metadata->>'field_path';
    v_mutation := coalesce(NEW.metadata->>'mutation', 'set');
    v_rank := CASE coalesce(NEW.metadata->>'source', 'agent')
                WHEN 'user' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END;

    IF NOT EXISTS (
        SELECT 1 FROM public.entities
        WHERE id = v_entity_id
          AND organization_id = NEW.organization_id
          AND deleted_at IS NULL
    ) THEN
        RETURN NEW;  -- unknown, deleted, or cross-org entity: never project
    END IF;

    IF v_mutation = 'remove' THEN
        -- A removal only wins under the same precedence as a set: a higher-ranked
        -- (or newer same-rank) edit can drop the field; a lower-ranked one cannot.
        DELETE FROM public.entity_field_state
        WHERE entity_id = v_entity_id
          AND field = v_field
          AND (v_rank < source_rank
               OR (v_rank = source_rank AND observation_id < NEW.id));
    ELSE
        INSERT INTO public.entity_field_state
            (organization_id, entity_id, field, value, observation_id, source_rank, updated_at)
        VALUES
            (NEW.organization_id, v_entity_id, v_field, NEW.metadata->'corrected_value', NEW.id, v_rank, now())
        ON CONFLICT (entity_id, field) DO UPDATE
            SET value = EXCLUDED.value,
                observation_id = EXCLUDED.observation_id,
                source_rank = EXCLUDED.source_rank,
                updated_at = now()
            WHERE EXCLUDED.source_rank < entity_field_state.source_rank
               OR (EXCLUDED.source_rank = entity_field_state.source_rank
                   AND entity_field_state.observation_id < EXCLUDED.observation_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- migrate:down

ALTER TABLE public.entity_field_state DROP COLUMN IF EXISTS source_rank;

-- Restore the rank-free keep-greater-by-observation_id projection.
CREATE OR REPLACE FUNCTION public.project_entity_field() RETURNS trigger AS $$
DECLARE
    v_entity_id bigint;
    v_field text;
    v_mutation text;
BEGIN
    IF coalesce(NEW.metadata->>'entity_id', '') !~ '^[0-9]{1,18}$'
       OR coalesce(NEW.metadata->>'field_path', '') = '' THEN
        RETURN NEW;
    END IF;
    v_entity_id := (NEW.metadata->>'entity_id')::bigint;
    v_field := NEW.metadata->>'field_path';
    v_mutation := coalesce(NEW.metadata->>'mutation', 'set');

    IF NOT EXISTS (
        SELECT 1 FROM public.entities
        WHERE id = v_entity_id
          AND organization_id = NEW.organization_id
          AND deleted_at IS NULL
    ) THEN
        RETURN NEW;
    END IF;

    IF v_mutation = 'remove' THEN
        DELETE FROM public.entity_field_state
        WHERE entity_id = v_entity_id
          AND field = v_field
          AND observation_id < NEW.id;
    ELSE
        INSERT INTO public.entity_field_state
            (organization_id, entity_id, field, value, observation_id, updated_at)
        VALUES
            (NEW.organization_id, v_entity_id, v_field, NEW.metadata->'corrected_value', NEW.id, now())
        ON CONFLICT (entity_id, field) DO UPDATE
            SET value = EXCLUDED.value,
                observation_id = EXCLUDED.observation_id,
                updated_at = now()
            WHERE entity_field_state.observation_id < EXCLUDED.observation_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
