import { Client } from 'pg';
import logger from '../utils/logger';

function getPgSsl() {
  return process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'prefer'
    ? { rejectUnauthorized: false }
    : undefined;
}

export async function withAdvisoryLock<T>(
  lockKey: number,
  jobName: string,
  fn: () => Promise<T>
): Promise<{ acquired: boolean; result?: T }> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for scheduler locks');
  }

  const client = new Client({
    connectionString,
    ssl: getPgSsl(),
    application_name: `owletto-scheduler-${jobName}`,
  });

  await client.connect();

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockKey]
    );

    if (!lockResult.rows[0]?.acquired) {
      return { acquired: false };
    }

    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      } catch (error) {
        logger.warn({ error, jobName }, '[scheduler] Failed to release advisory lock');
      }
    }
  } finally {
    await client.end();
  }
}
