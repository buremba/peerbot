-- migrate:up

-- One edit model: entity field edits now emit the SAME field-grained shape as a
-- watcher correction — one 'entity_field' event per field, metadata
-- { entity_id, field_path, mutation, corrected_value } (was a single fields-map
-- snapshot { entity_id, fields }). Rewrite the projection trigger to read that
-- shape: one event → one (entity, field) upsert, keep-greater by observation_id;
-- a 'remove' mutation deletes the field. Fire condition is unchanged
-- (semantic_type='entity_field'), so no watcher 'correction' events are touched.
CREATE OR REPLACE FUNCTION public.project_entity_field() RETURNS trigger AS $$
DECLARE
    v_entity_id bigint;
    v_field text;
    v_mutation text;
BEGIN
    IF coalesce(NEW.metadata->>'entity_id', '') !~ '^[0-9]{1,18}$'
       OR coalesce(NEW.metadata->>'field_path', '') = '' THEN
        RETURN NEW;  -- not a field-grained entity edit: skip
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
        RETURN NEW;  -- unknown, deleted, or cross-org entity: never project
    END IF;

    IF v_mutation = 'remove' THEN
        -- Drop the field, but only if this removal is newer than the stored value
        -- (keep-greater ordering, same as the set path below).
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

-- migrate:down

-- Restore the fields-map projection.
CREATE OR REPLACE FUNCTION public.project_entity_field() RETURNS trigger AS $$
DECLARE
    v_entity_id bigint;
BEGIN
    IF coalesce(jsonb_typeof(NEW.metadata->'fields'), '') <> 'object'
       OR coalesce(NEW.metadata->>'entity_id', '') !~ '^[0-9]{1,18}$' THEN
        RETURN NEW;
    END IF;
    v_entity_id := (NEW.metadata->>'entity_id')::bigint;

    IF NOT EXISTS (
        SELECT 1 FROM public.entities
        WHERE id = v_entity_id
          AND organization_id = NEW.organization_id
          AND deleted_at IS NULL
    ) THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.entity_field_state (organization_id, entity_id, field, value, observation_id, updated_at)
    SELECT NEW.organization_id, v_entity_id, kv.key, kv.value, NEW.id, now()
    FROM jsonb_each(NEW.metadata->'fields') kv
    ON CONFLICT (entity_id, field) DO UPDATE
        SET value = EXCLUDED.value,
            observation_id = EXCLUDED.observation_id,
            updated_at = now()
        WHERE entity_field_state.observation_id < EXCLUDED.observation_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
