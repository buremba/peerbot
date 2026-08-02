import { getDb } from '../db/client';
import logger from '../utils/logger';

const SNAPSHOT_RETENTION_DAYS = 30;

export async function sweepToolInvocationSnapshots(): Promise<{
  deleted: number;
}> {
  const sql = getDb();
  const deleted = await sql`
    DELETE FROM tool_invocation_snapshots
    WHERE created_at < now() - make_interval(days => ${SNAPSHOT_RETENTION_DAYS})
  `;
  if (deleted.count > 0) {
    logger.info(
      { deleted: deleted.count, retentionDays: SNAPSHOT_RETENTION_DAYS },
      'Swept expired tool request snapshots',
    );
  }
  return { deleted: deleted.count };
}
