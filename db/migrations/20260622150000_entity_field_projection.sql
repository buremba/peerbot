-- migrate:up

-- Event-sourced entity field state — SUBSTRATE (expand phase, 1 of N).
--
-- entity_field_state is a trigger-maintained projection of the events log: the
-- current value of each (entity_id, metadata field) is the latest 'entity_field'
-- event carrying it. The events log stays the source of truth; this table is a
-- rebuildable cache. Validated by a live PG17 concurrency prototype — correct
-- under maximum contention (the keep-greater ON CONFLICT row-lock serializes
-- concurrent writers, N>1-safe), microsecond PK reads, ~1.4s rebuild over 2M events.
--
-- This migration ships the SUBSTRATE only — nothing emits 'entity_field' events
-- yet, so the projection is empty and inert in prod (the WHEN-gated trigger costs
-- nothing on non-field inserts). The producer (manage_entity emitting field
-- events inside the entity-update transaction, for correct ordering) is a
-- separate follow-up; it must respect the event contract below.
--
-- EVENT CONTRACT for 'entity_field':
--   semantic_type   = 'entity_field'
--   entity_ids      = '{}'  (INTENTIONALLY EMPTY — these rows must never match
--                            entity-linked content counts / feeds / search, which
--                            key on entity_ids; cf. recordLifecycleEvent's empty
--                            entity_ids precedent)
--   organization_id = <the events.organization_id column>  (tenancy)
--   metadata        = { "entity_id": <number>, "fields": { "<key>": <value>, ... } }

CREATE TABLE IF NOT EXISTS public.entity_field_state (
    organization_id text   NOT NULL,
    entity_id       bigint NOT NULL,
    field           text   NOT NULL,
    value           jsonb,
    observation_id  bigint NOT NULL,
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT entity_field_state_pkey PRIMARY KEY (entity_id, field)
);

-- organization_id is stored for tenancy + the contract-phase orphan sweep (entity
-- ids are globally unique, so it is not part of the PK). The supporting index
-- lands with that sweep, not here — nothing scans by org in the expand phase.

COMMENT ON TABLE public.entity_field_state IS
    'Trigger-maintained projection of the latest entity_field event per (entity_id, field). Rebuildable cache; the events log is the source of truth. No FK to entities (an append-only log may reference deleted entities; orphans are harmless cache rows swept in the contract phase).';

-- keep-greater-observation_id upsert. events.id is monotonic at assignment, so a
-- later write carries the higher id; the ON CONFLICT row-lock serializes two
-- concurrent upserts on the same (entity_id, field). Multi-replica-safe:
-- serialization happens in Postgres, not in any pod's memory.
--
-- Two hard safety properties, since this fires on the HOT append-only events
-- table and the table has no org in its PK / no FK:
--   * NULL-safe, integer-validated guard (coalesce + 1..18-digit regex) BEFORE
--     the ::bigint cast — a missing / float / overflowing / non-object payload
--     degrades to a no-op and can NEVER abort the host events insert.
--   * Tenancy boundary: only projects for an entity that actually belongs to the
--     event's organization, so a cross-org event can't hijack or re-stamp a row
--     (organization_id is therefore NOT updated on conflict — it's immutable per
--     entity). Unknown/deleted entities are skipped (also covers the no-FK case).
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
        RETURN NEW;  -- unknown, deleted, or cross-org entity: skip, never project
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

-- WHEN clause keeps the 99% non-field inserts from ever entering the plpgsql
-- frame (predicate evaluated in C). Sibling of the append-only BEFORE DELETE
-- guard — disjoint timing/event, no conflict.
DROP TRIGGER IF EXISTS trg_project_entity_field ON public.events;
CREATE TRIGGER trg_project_entity_field
    AFTER INSERT ON public.events
    FOR EACH ROW
    WHEN (NEW.semantic_type = 'entity_field')
    EXECUTE FUNCTION public.project_entity_field();

-- migrate:down
DROP TRIGGER IF EXISTS trg_project_entity_field ON public.events;
DROP FUNCTION IF EXISTS public.project_entity_field();
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.entity_field_state;
