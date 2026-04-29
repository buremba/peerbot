/**
 * `pg.Pool` singleton, retained only because `@chat-adapter/state-pg`'s API
 * accepts a `pg.Pool` directly. Everything else in this codebase (queries,
 * caches, queue, LISTEN) goes through the postgres-js pool in `db/client.ts`.
 *
 * Pool size is intentionally small — state-pg's chat-state UPSERT/SELECT
 * traffic is light and finishes quickly, so 4 concurrent connections is
 * more than enough; raise via `PG_POOL_MAX` if the chat workload grows.
 *
 * Reach for `getDb()` first. This module is the escape hatch for the one
 * upstream library that demands node-postgres.
 */

import { Pool, type PoolConfig } from 'pg';
import logger from '../utils/logger';

let pgPoolSingleton: Pool | null = null;

function getPgSsl() {
  return process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'prefer'
    ? { rejectUnauthorized: false }
    : undefined;
}

/** Get the singleton `pg.Pool`. Lazily constructed on first call. */
export function getPgPool(): Pool {
  if (pgPoolSingleton) return pgPoolSingleton;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to construct pg.Pool');
  }

  const config: PoolConfig = {
    connectionString,
    ssl: getPgSsl(),
    application_name: 'owletto-backend-state-pg',
    max: parseInt(process.env.PG_POOL_MAX || '4', 10),
    idleTimeoutMillis: 30_000,
  };

  pgPoolSingleton = new Pool(config);
  pgPoolSingleton.on('error', (err) => {
    logger.warn({ err: String(err) }, '[pg-pool] idle client error');
  });
  logger.info('[pg-pool] singleton constructed');
  return pgPoolSingleton;
}

/**
 * Tear down the pool. Tests use this; production never should.
 */
export async function closePgPool(): Promise<void> {
  if (!pgPoolSingleton) return;
  const pool = pgPoolSingleton;
  pgPoolSingleton = null;
  await pool.end();
}
