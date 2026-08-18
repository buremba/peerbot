-- migrate:up

-- Per-type write rules: TypeScript the ontology author writes, compiled at
-- apply time and executed at the entity row-write seam.
--
-- Storage shape mirrors `automations.reaction_script` / `reaction_script_compiled`
-- exactly: source is kept so the authored text is readable and diffable, and
-- the compiled JS is kept so the write path never bundles the author's
-- TypeScript (npm resolution, imports, transform); `run-script` still runs the
-- stored artifact through a memoized esbuild pass once per process.
--
-- Why two columns on `entity_types` rather than a new table: a rule has exactly
-- one owner and no independent lifecycle — it is created, versioned and dropped
-- with its type, and it is always read on the row the write seam has already
-- fetched. The seam's committed-row read already joins `entity_types`, so
-- `rules_compiled` rides that join and costs ZERO additional queries. A separate
-- table would add a join to the hot write path for a strict 1:1.
--
-- Why not inside `metadata_schema` (where the entity-resolution policy lives as
-- `x-lobu-resolution`): that key holds declarative DATA. A rule is code. Storing
-- a compiled bundle inside a JSON Schema document would make the schema
-- unreadable, defeat diffing, and force every schema reader to skip a field it
-- cannot interpret.
--
-- Inert for every EXISTING type: both columns default to NULL, and a NULL
-- `rules_compiled` means "no rule for this type", which is exactly the behaviour
-- every type has today. Only a type whose author declares rules is affected.
-- Schema-before-code so a rolling deploy never runs new code against an old
-- table.
ALTER TABLE public.entity_types
  ADD COLUMN IF NOT EXISTS rules_source text,
  ADD COLUMN IF NOT EXISTS rules_compiled text;

COMMENT ON COLUMN public.entity_types.rules_source IS
  'TypeScript source for this type''s write rules, as authored. NULL = no rules.';

COMMENT ON COLUMN public.entity_types.rules_compiled IS
  'Compiled JavaScript from rules_source, executed in an isolate at the entity row-write seam. NULL = no rules.';

-- migrate:down

ALTER TABLE public.entity_types
  DROP COLUMN IF EXISTS rules_compiled,
  DROP COLUMN IF EXISTS rules_source;
