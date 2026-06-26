-- migrate:up

-- Per-field human-ownership markers on entities, for the watcher<->human feedback
-- loop. A key present under field_controls means that field's current value was set
-- by a human and is authoritative: a watcher may PROPOSE a change (via an approval)
-- but must never overwrite it directly. Stored as a column on entities (not a side
-- table) so promotion and prompt-render read it for free with the entity row, and it
-- is written atomically with entities.metadata under the same FOR UPDATE lock.
--   shape: { "<field_path>": { "note": text|null, "set_by": "<userId>", "set_at": iso8601 } }
--   absence of a key = automation may write that field freely.
-- Constant DEFAULT '{}' is a metadata-only add on PG11+ (no table rewrite).
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS field_controls jsonb NOT NULL DEFAULT '{}'::jsonb;

-- migrate:down
ALTER TABLE public.entities DROP COLUMN IF EXISTS field_controls;
