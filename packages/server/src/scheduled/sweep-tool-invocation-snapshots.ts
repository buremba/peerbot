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
 * Bounded per tick so one run can never hold a long transaction over a table
 * that also serves reads; the job runs daily and a backlog drains across ticks.
 */

import { getDb } from '../db/client';
import logger from '../utils/logger';

export const SNAPSHOT_RETENTION_DAYS = 30;
const MAX_DELETES_PER_TICK = 20_000;

export async function sweepToolInvocationSnapshots(
  retentionDays = SNAPSHOT_RETENTION_DAYS
): Promise<{ deleted: number }> {
  const sql = getDb();
  const deleted = await sql<{ event_id: string }>`
    DELETE FROM tool_invocation_snapshots
    WHERE event_id IN (
      SELECT event_id
      FROM tool_invocation_snapshots
      WHERE created_at < now() - make_interval(days => ${retentionDays})
      ORDER BY created_at
      LIMIT ${MAX_DELETES_PER_TICK}
    )
    RETURNING event_id
  `;
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, retentionDays },
      'Swept expired tool invocation snapshot bodies'
    );
  }
  return { deleted: deleted.length };
}
