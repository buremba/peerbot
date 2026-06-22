#!/usr/bin/env bash
#
# Out-of-band batched backfill of event_edges 'membership' edges from watcher_window_events
# (windows-as-events P6 phase 1). watcher_window_events is events-scaled (~3-5M rows), so the
# migration (20260622240000) creates the table + trigger ONLY — new links are populated by the
# AFTER trigger; this backfills historic links in ~10k-row batches, each its own transaction
# with a sleep, so no single statement risks the Helm-hook statement_timeout outage.
#
# ORG SCOPING (cross-org-leak surface): the edge's org resolves via
# watcher_window_events.window_id -> watcher_windows.watcher_id -> watchers.organization_id
# (the window's owning watcher). Rows whose org can't be resolved are skipped (the JOIN omits
# them), never assigned a guessed org. watcher_id_hint = the window's watcher_id.
#
# Idempotent + resumable (ON CONFLICT DO NOTHING). Must complete before the read phase.
#
# Usage: DATABASE_URL=postgres://... ./scripts/backfill-event-edges.sh
#   BATCH=10000  rows per batch    SLEEP=0.5  seconds between batches

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BATCH=${BATCH:-10000}
SLEEP=${SLEEP:-0.5}

echo "Backfilling event_edges membership (batch=${BATCH}, sleep=${SLEEP}s)…"
total=0
while :; do
  # The batch INNER-JOINs to resolve org, so rows whose owning watcher/org can't be resolved
  # are excluded (never selected -> no infinite loop on orphans, just silently skipped — an
  # orphan window has no valid org, so no edge). Loop terminates once all resolvable
  # without-an-edge rows are inserted (count 0).
  n=$(psql "$DATABASE_URL" -tA -c "
    WITH batch AS (
      SELECT wwe.window_id, wwe.event_id, wwe.created_at, ww.watcher_id, w.organization_id
      FROM watcher_window_events wwe
      JOIN watcher_windows ww ON ww.id = wwe.window_id
      JOIN watchers w ON w.id = ww.watcher_id
      WHERE NOT EXISTS (
        SELECT 1 FROM event_edges ee
        WHERE ee.parent_event_id = wwe.window_id
          AND ee.child_event_id = wwe.event_id
          AND ee.edge_type = 'membership'
      )
      ORDER BY wwe.window_id, wwe.event_id
      LIMIT ${BATCH}
    ), ins AS (
      INSERT INTO event_edges
        (organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint, created_at)
      SELECT organization_id, window_id, event_id, 'membership', watcher_id, COALESCE(created_at, now())
      FROM batch
      ON CONFLICT (parent_event_id, child_event_id, edge_type) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) FROM ins;
  ")
  n=${n//[[:space:]]/}
  total=$((total + n))
  echo "  batch: ${n} (total ${total})"
  [ "${n}" -eq 0 ] && break
  sleep "${SLEEP}"
done
echo "Done. Backfilled ${total} membership edges."
