-- Phase 1 of removing the connector repair-agent subsystem.
--
-- Application code and QUERYABLE_SCHEMA no longer read the repair_* columns.
-- Per docs/GOTCHAS.md ("Dropping a column from a queryable table is a
-- two-phase change"), the physical DROP COLUMN ships in a later release after
-- this code is fully rolled out — so old replicas mid-deploy never SELECT a
-- column that no longer exists.
--
-- Remediation path: feed hard auto-pause → feed.auto_paused lifecycle event +
-- optional catalog Behavior template (opt-in install). No repair-agent threads.
--
-- Phase-2 follow-up: DROP feeds.repair_* and
-- connector_definitions.default_repair_agent_id + feeds_open_repair_thread_uniq.

-- migrate:up
SELECT 1;

-- migrate:down
SELECT 1;
