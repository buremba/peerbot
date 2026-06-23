#!/usr/bin/env bash
#
# Out-of-band batched backfill of event_classifications.classifier_id (classifier fold
# phase 1). Per docs/MIGRATIONS.md, event_classifications is events-scaled (~1M+ rows in
# prod), so the stable-id migration (20260622230000) adds the column + trigger ONLY — new
# rows are populated by the BEFORE trigger; this script backfills the historic rows in
# ~10k-row batches, each its own transaction with a sleep between, so VACUUM keeps up and no
# single statement risks the Helm-hook statement_timeout outage.
#
# Idempotent + resumable: re-running only touches still-NULL rows. Safe to run anytime; must
# complete before the read/FK phase (which relies on classifier_id being populated).
#
# Usage: DATABASE_URL=postgres://... ./scripts/backfill-classifier-stable-id.sh
#   BATCH=10000  rows per batch (default 10000)
#   SLEEP=0.2    seconds between batches (default 0.2)

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BATCH=${BATCH:-10000}
SLEEP=${SLEEP:-0.2}

echo "Backfilling event_classifications.classifier_id (batch=${BATCH}, sleep=${SLEEP}s)…"
total=0
while :; do
  # FOR UPDATE SKIP LOCKED so a concurrent live write never blocks the batch (and vice versa);
  # each psql -c is its own transaction.
  n=$(psql "$DATABASE_URL" -tA -c "
    WITH batch AS (
      SELECT id FROM event_classifications
      WHERE classifier_id IS NULL AND classifier_version_id IS NOT NULL
      ORDER BY id
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    ), upd AS (
      UPDATE event_classifications ec
      SET classifier_id = ecv.classifier_id
      FROM event_classifier_versions ecv
      WHERE ec.id IN (SELECT id FROM batch) AND ecv.id = ec.classifier_version_id
      RETURNING ec.id
    )
    SELECT count(*) FROM upd;
  ")
  n=${n//[[:space:]]/}
  total=$((total + n))
  echo "  batch: ${n} (total ${total})"
  [ "${n}" -eq 0 ] && break
  sleep "${SLEEP}"
done
echo "Done. Backfilled ${total} rows."
