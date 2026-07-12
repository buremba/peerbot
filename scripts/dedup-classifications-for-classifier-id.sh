#!/usr/bin/env bash
#
# Classifier collapse (P4 phase 5a) — out-of-band collision dedup of event_classifications,
# the precondition for the new stable-key unique index idx_cc_unique_per_source_v2
# (event_id, classifier_id, source, COALESCE(watcher_id,0)).
#
# WHY: today uniqueness is per (event_id, classifier_VERSION_id, source, watcher). Collapsing the
# key onto the stable classifier_id can collide IFF a single (event, classifier, source, watcher)
# was classified under TWO versions of the same classifier (same source). In practice this is
# ZERO — each classifier is permanently v1, the hot path delete-then-reinserts by the current
# version, and version switches (the only multi-version source) are a zero-caller headless API.
# So this is a SAFETY NET: it keeps the highest id (latest) row per stable key and deletes the
# rest, logging the count. Run + confirm it deletes 0 in prod before applying the index migration.
#
# Events-scaled (~1M+ rows): batched (each its own tx, sleep between) per docs/MIGRATIONS.md.
# Idempotent + resumable. Requires classifier_id backfilled first
# (scripts/backfill-classifier-stable-id.sh).
#
# Usage: DATABASE_URL=postgres://... ./scripts/dedup-classifications-for-classifier-id.sh
#   BATCH=10000  collision groups per batch (default 10000)
#   SLEEP=0.2    seconds between batches (default 0.2)

set -euo pipefail
PSQL=(psql "${DATABASE_URL:?set DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc)
BATCH="${BATCH:-10000}"
SLEEP="${SLEEP:-0.2}"
total=0
while :; do
  # Each batch: find up to BATCH colliding stable keys, keep MAX(id) per key, delete the rest.
  N=$("${PSQL[@]}" "
    WITH dupes AS (
      SELECT event_id, classifier_id, source, COALESCE(watcher_id, 0) AS w, MAX(id) AS keep_id
      FROM event_classifications
      WHERE classifier_id IS NOT NULL
      GROUP BY event_id, classifier_id, source, COALESCE(watcher_id, 0)
      HAVING count(*) > 1
      LIMIT ${BATCH}
    ), del AS (
      DELETE FROM event_classifications ec
      USING dupes d
      WHERE ec.event_id = d.event_id
        AND ec.classifier_id = d.classifier_id
        AND ec.source = d.source
        AND COALESCE(ec.watcher_id, 0) = d.w
        AND ec.id <> d.keep_id
      RETURNING 1
    ) SELECT count(*) FROM del;
  ")
  total=$((total + N))
  echo "deduped batch: ${N} rows removed (running total ${total})"
  [ "${N}" -eq 0 ] && break
  sleep "${SLEEP}"
done
echo "classifier-id dedup complete — ${total} duplicate classification rows removed"
