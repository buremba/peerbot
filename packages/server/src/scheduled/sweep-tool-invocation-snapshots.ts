/**
 * Tool-invocation snapshot retention sweep.
 *
 * Snapshot bodies are a debugging/audit convenience with a short useful life:
 * you open one to see what a script or query actually did, days after the fact
 * at most. The audit LEDGER — who called what, when, whether it succeeded, the
 * arg hash — is permanent and lives on `events`, untouched by this job.
 *
 * That split is the whole reason bodies are a separate relation. `events` is
 * append-only by invariant, so a body stored inside it could never expire; here
 * a plain DELETE ages them out and no event row is modified or removed.
 *
 * Each DELETE is bounded so one statement can never hold a long transaction
 * over a table that also serves reads. The tick then loops until a batch comes
 * back short — a single bounded statement per day would only keep up while
 * captures stayed under one batch/day, and above that rate the expired backlog
 * would grow without bound and bodies would outlive the retention horizon.
 * The total-work cap is the backstop: it bounds one tick's runtime, and what it
 * leaves behind is picked up by the next tick.
 */

import { getDb } from '../db/client';
import logger from '../utils/logger';

const SNAPSHOT_RETENTION_DAYS = 30;
const MAX_DELETES_PER_BATCH = 20_000;
const MAX_DELETES_PER_TICK = 1_000_000;

export async function sweepToolInvocationSnapshots(): Promise<{ deleted: number }> {
  const sql = getDb();
  let total = 0;
  let batches = 0;
  while (total < MAX_DELETES_PER_TICK) {
    const batchLimit = Math.min(MAX_DELETES_PER_BATCH, MAX_DELETES_PER_TICK - total);
    // No RETURNING: postgres.js fills `count` from the command tag, so the row
    // ids never cross the wire. With a million-row tick cap that is the
    // difference between counting and shipping a million ids to count them.
    const deleted = await sql`
      DELETE FROM tool_invocation_snapshots
      WHERE event_id IN (
        SELECT event_id
        FROM tool_invocation_snapshots
        WHERE created_at < now() - make_interval(days => ${SNAPSHOT_RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${batchLimit}
      )
    `;
    total += deleted.count;
    batches++;
    // Short batch means the expired set is drained; anything created after this
    // point is inside the retention horizon and not this tick's work.
    if (deleted.count < batchLimit) break;
  }
  if (total > 0) {
    logger.info(
      { deleted: total, batches, retentionDays: SNAPSHOT_RETENTION_DAYS, capped: total >= MAX_DELETES_PER_TICK },
      'Swept expired tool invocation snapshot bodies'
    );
  }
  return { deleted: total };
}
