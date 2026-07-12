-- ============================================================================
-- PR1 data reconcile: heal existing Slack channel bindings whose team_id holds
-- a Grid ENTERPRISE id (E…) instead of the concrete WORKSPACE id (T…).
--
-- INVARIANT (enforced by this PR going forward): agent_channel_bindings.team_id
-- ALWAYS names the concrete Slack WORKSPACE (T…), never the enterprise id (E…).
-- Historical rows written by the connection-derived binding writers copied the
-- connection's external_tenant_id (the E… on an org-wide install) into team_id.
--
-- This backfills those rows to the real T… sourced from captured inbound
-- messages (`channel_messages.team_id`), which reliably carry the real workspace
-- (never the enterprise id). A binding with NO captured message to source from
-- is set to NULL ("unknown yet") so it self-heals from the first inbound
-- message — we NEVER leave an E… in team_id, and we NEVER invent a workspace.
--
-- Contract:
--   * READ-ONLY / rollback-by-default. Wrapped in a transaction that ROLLBACKs.
--     Flip to COMMIT for the real run after reviewing the preview counts.
--   * events is APPEND-ONLY. This touches ONLY agent_channel_bindings. It never
--     DELETEs from events (or anything else) — it UPDATEs team_id in place.
--   * Idempotent: re-running only affects rows still holding a non-T… team.
--   * Manual, parked for a supervised prod run (NOT auto-applied by a migration).
--
-- Usage:
--   psql "$DATABASE_URL" -f PR1-data-reconcile.sql          # preview (rollback)
--   then set the final ROLLBACK → COMMIT and re-run to apply.
-- ============================================================================

BEGIN;

-- An "E… team" binding is any Slack binding whose team_id is NOT a workspace id
-- (T…). We match the enterprise shape explicitly (E…) AND, defensively, any
-- non-T… non-null team so a stray value can't slip through.
-- ---------------------------------------------------------------------------

-- Preview: how many Slack bindings currently hold a non-workspace team_id.
SELECT
  count(*)                                              AS non_workspace_bindings,
  count(*) FILTER (WHERE b.team_id ~ '^E')             AS enterprise_id_bindings
FROM agent_channel_bindings b
WHERE b.platform LIKE 'slack%'
  AND b.team_id IS NOT NULL
  AND b.team_id !~ '^T';

-- The real workspace per (connection_id, channel_id): the most-recently-seen
-- T… team on a captured inbound message for that channel. channel_messages
-- carries the message's real workspace id (never the enterprise id).
CREATE TEMP TABLE _binding_real_team ON COMMIT DROP AS
SELECT DISTINCT ON (cm.connection_id, cm.channel_id)
  cm.connection_id,
  cm.channel_id,
  cm.team_id AS real_team_id
FROM channel_messages cm
WHERE cm.platform LIKE 'slack%'
  AND cm.team_id ~ '^T'
ORDER BY cm.connection_id, cm.channel_id, cm.occurred_at DESC;

-- 1) Backfill the real workspace where we have message evidence.
--    Match channel_messages on the binding's connection + channel. Bindings
--    store the canonical `slack:C…` key; captured messages may store the bare
--    or prefixed id — try both.
UPDATE agent_channel_bindings b
SET team_id = t.real_team_id
FROM _binding_real_team t
WHERE b.platform LIKE 'slack%'
  AND b.team_id IS NOT NULL
  AND b.team_id !~ '^T'
  AND b.connection_id = t.connection_id
  AND (
        b.channel_id = t.channel_id
     OR b.channel_id = 'slack:' || t.channel_id
     OR 'slack:' || b.channel_id = t.channel_id
  );

-- 2) Any remaining non-workspace team_id has NO message evidence to source a
--    real workspace from. Set it to NULL ("unknown yet") so it self-heals from
--    the first inbound message — NEVER leave an E… in place.
UPDATE agent_channel_bindings b
SET team_id = NULL
WHERE b.platform LIKE 'slack%'
  AND b.team_id IS NOT NULL
  AND b.team_id !~ '^T';

-- Post-reconcile verification: zero Slack bindings should hold a non-T… team.
SELECT
  count(*) FILTER (WHERE b.team_id ~ '^T')                       AS workspace_bindings,
  count(*) FILTER (WHERE b.team_id IS NULL)                      AS null_team_bindings_to_heal,
  count(*) FILTER (WHERE b.team_id IS NOT NULL AND b.team_id !~ '^T') AS remaining_bad_bindings
FROM agent_channel_bindings b
WHERE b.platform LIKE 'slack%';

-- Default: preview only. Flip to COMMIT for the supervised apply.
ROLLBACK;
-- COMMIT;
