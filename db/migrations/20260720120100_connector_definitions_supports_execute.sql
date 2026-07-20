-- migrate:up

-- Persisted capability flag so operations READINESS uses the SAME signal as
-- EXECUTION (#2033 item 2). Readiness derives from `actions_schema` (the catalog
-- metadata), but execution loads the compiled connector runtime and throws
-- "Actions not supported" when the runtime does NOT override execute(). The base
-- ConnectorRuntime defines execute() (rejecting), so declaring actions does NOT
-- imply the code implements them — metadata and code can disagree.
--
-- We compute the real capability ONCE at compile/install time (does the concrete
-- runtime class own an `execute` method, i.e. override the base?) and persist it
-- here. Readiness reads it cheaply on the hot list_available path — no
-- per-listing compilation.
--
-- Semantics:
--   TRUE   → the runtime overrides execute(): local_action ops are executable.
--   FALSE  → the runtime does NOT override execute(): local_action ops report
--            readiness='unsupported', executable=false.
--   NULL   → legacy row installed before this flag existed. Treated as "assume
--            supported" so no existing connector regresses; the flag is stamped
--            precisely on the next (re)install.
ALTER TABLE connector_definitions
  ADD COLUMN IF NOT EXISTS supports_execute boolean;

COMMENT ON COLUMN connector_definitions.supports_execute IS
  'Whether the compiled connector runtime overrides execute() (local_action capability). NULL = legacy/unknown, treated as supported. Set at install time.';

-- migrate:down

ALTER TABLE connector_definitions
  DROP COLUMN IF EXISTS supports_execute;
