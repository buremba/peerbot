-- migrate:up

-- The reaction owns its input contract (an exported TypeBox `input` schema).
-- We extract that JSON Schema at set_reaction_script time and cache it here so
-- the worker can be told the exact shape the reaction will Value.Parse — i.e.
-- deriveWatcherExtractionSchema returns this for reaction watchers that name no
-- entity_type (otherwise the worker free-forms `{ summary }` and the reaction
-- rejects it). Group-shared, alongside reaction_script. NULL ⇒ no input export
-- (free-form fallback).
ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS reaction_input_schema jsonb;

-- migrate:down

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS reaction_input_schema;
