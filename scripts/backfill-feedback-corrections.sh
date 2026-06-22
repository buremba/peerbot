#!/usr/bin/env bash
# Correction-events (P1) phase 1 backfill: mirror historic watcher_window_field_feedback rows
# into the events spine as semantic_type='correction'. OUT OF BAND + batched (events is large);
# idempotent via NOT EXISTS on origin_id (re-runnable). Each batch is its own tx. created_by is
# FK-safe-resolved (NULL if not a valid user), matching the trigger.
set -euo pipefail
PSQL=(psql "${DATABASE_URL:?set DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc)
BATCH="${BATCH:-5000}"
while :; do
  N=$("${PSQL[@]}" "
    WITH batch AS (
      SELECT f.* FROM watcher_window_field_feedback f
      WHERE NOT EXISTS (
        SELECT 1 FROM events e WHERE e.origin_id = 'wwff_' || f.id::text AND e.semantic_type = 'correction'
      )
      ORDER BY f.id LIMIT ${BATCH}
    ), ins AS (
      INSERT INTO events
        (organization_id, semantic_type, entity_ids, origin_id, metadata, created_by, occurred_at, created_at)
      SELECT b.organization_id, 'correction', '{}'::bigint[], 'wwff_' || b.id::text,
        jsonb_build_object('window_id', b.window_id, 'watcher_id', b.watcher_id, 'field_path', b.field_path,
          'mutation', b.mutation, 'corrected_value', b.corrected_value, 'note', b.note),
        (SELECT u.id FROM \"user\" u WHERE u.id = b.created_by), b.created_at, b.created_at
      FROM batch b RETURNING 1
    ) SELECT count(*) FROM ins;
  ")
  echo "backfilled batch: ${N}"
  [ "${N}" -eq 0 ] && break
  sleep 0.2
done
echo "feedback->correction backfill complete"
