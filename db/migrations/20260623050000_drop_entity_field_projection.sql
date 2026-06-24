-- migrate:up

-- Remove the event-sourced entity_field projection (P5). It shipped substrate
-- first — a trigger-maintained cache (entity_field_state) fed by a per-field
-- event producer in manage_entity — but NO read path ever consumed it: entity
-- metadata is still served from the entities.metadata blob. So the table, its
-- trigger, and the producer were pure overhead on the hot entity-write path (one
-- 'entity_field' event per changed field per write, folded into a cache nobody
-- reads). Drop the DB side here; the producer (emitEntityFieldEvent) is removed
-- from entity-management.ts in the same change.
--
-- Already-emitted 'entity_field' events stay in the append-only log — they are
-- harmless (entity_ids='{}', no payload_text, so they match no content/search/
-- count query) and the events table is never rewritten.

DROP TRIGGER IF EXISTS trg_project_entity_field ON public.events;
DROP FUNCTION IF EXISTS public.project_entity_field();
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.entity_field_state;

-- migrate:down

-- Recreate the projection as it stood immediately before this drop: the table
-- (from 20260622150000) + the field-grained trigger/function (from
-- 20260623040000, metadata = {entity_id, field_path, mutation, corrected_value}).
CREATE TABLE IF NOT EXISTS public.entity_field_state (
    organization_id text   NOT NULL,
    entity_id       bigint NOT NULL,
    field           text   NOT NULL,
    value           jsonb,
    observation_id  bigint NOT NULL,
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT entity_field_state_pkey PRIMARY KEY (entity_id, field)
);

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

DROP TRIGGER IF EXISTS trg_project_entity_field ON public.events;
CREATE TRIGGER trg_project_entity_field
    AFTER INSERT ON public.events
    FOR EACH ROW
    WHEN (NEW.semantic_type = 'entity_field')
    EXECUTE FUNCTION public.project_entity_field();
