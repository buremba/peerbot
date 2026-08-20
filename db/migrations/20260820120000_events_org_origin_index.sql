-- migrate:up transaction:false

-- The promotions-pause gate verifies a claimed rollback by probing for the
-- deployment it says it is undoing:
--
--   SELECT 1 FROM events
--   WHERE organization_id = $1 AND origin_id = 'deployment_<apply_id>'
--
-- That runs on a REQUEST path (utils/deployment-pause.ts, reached from the
-- auth funnel and from executeTool), and `events` only grows. The one existing
-- (organization_id, origin_id) index is PARTIAL —
-- idx_events_live_suggestion_origin is predicated on
-- `superseded_by IS NULL AND interaction_type = 'suggestion'` — so a
-- deployment row matches neither clause and the probe cannot use it, leaving
-- an organization-wide scan that degrades with history.
--
-- Non-partial deliberately. A predicate narrowed to deployment rows (e.g.
-- origin_id LIKE 'deployment\_%') would be smaller, but Postgres does not
-- prove that an equality on origin_id implies a LIKE predicate, so the planner
-- would only use it if every call site repeated the LIKE clause verbatim — an
-- invariant nothing enforces and the next caller silently breaks. This index
-- also serves any other org-scoped origin_id lookup, which is the shape
-- cross-sync identity already keys on (see root AGENTS.md on origin_id).
--
-- CONCURRENTLY + transaction:false: `events` is the largest table and cannot
-- take a writes-blocking build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_org_origin
  ON public.events (organization_id, origin_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_org_origin;
