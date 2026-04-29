import { getRawDb } from '../db/client';
import logger from '../utils/logger';

/**
 * Run `fn` while holding a session-scoped Postgres advisory lock identified
 * by `lockKey`. Returns `{ acquired: false }` immediately if the lock is
 * already held by another session.
 *
 * Implementation: reserves a single connection from the postgres-js pool for
 * the duration of the call (via `sql.reserve()`) so the advisory lock and
 * the wrapped work both run on the same backend — required because PG
 * advisory locks are bound to a session, not a transaction. On `release()`,
 * any unlock that didn't run is a no-op (the connection returns to the pool
 * and the lock auto-releases when the session ends).
 */
export async function withAdvisoryLock<T>(
  lockKey: number,
  jobName: string,
  fn: () => Promise<T>
): Promise<{ acquired: boolean; result?: T }> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required for scheduler locks');
  }

  const sql = getRawDb();
  const reserved = await sql.reserve();

  try {
    const lockRows = await reserved<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`;

    if (!lockRows[0]?.acquired) {
      return { acquired: false };
    }

    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      try {
        await reserved`SELECT pg_advisory_unlock(${lockKey})`;
      } catch (error) {
        logger.warn(
          { error, jobName },
          '[scheduler] Failed to release advisory lock'
        );
      }
    }
  } finally {
    reserved.release();
  }
}
