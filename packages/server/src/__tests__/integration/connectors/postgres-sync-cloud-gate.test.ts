/**
 * Cloud gate on the scheduled-sync creation path (bug: feed-sync.ts gate was
 * dev-CLI-only, so a postgres feed kept syncing under LOBU_CLOUD_MODE).
 *
 * createSyncRun feeds the production poll path: CheckDueFeeds → createSyncRun →
 * `runs` row → pollWorkerJob claims it. Under LOBU_CLOUD_MODE a cloud-restricted
 * connector (postgres) must NOT get a run queued; self-hosted is unaffected. The
 * feed is left intact (it's valid, just cloud-gated), not soft-deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createSyncRun } from '../../../utils/queue-helpers';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';

async function setupPostgresFeed(): Promise<number> {
  const sql = getTestDb();
  const org = await createTestOrganization();
  await createTestConnectorDefinition({
    key: 'postgres',
    name: 'PostgreSQL',
    organization_id: org.id,
  });
  const conn = await createTestConnection({
    organization_id: org.id,
    connector_key: 'postgres',
  });
  const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${conn.id}`;
  return Number((feed as { id: number }).id);
}

describe('createSyncRun cloud gate (postgres)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('does NOT queue a postgres sync run under LOBU_CLOUD_MODE (feed left intact)', async () => {
    const sql = getTestDb();
    const feedId = await setupPostgresFeed();

    process.env.LOBU_CLOUD_MODE = '1';
    const runId = await createSyncRun(feedId, {} as Env, sql);

    expect(runId).toBeNull();
    const runs = await sql`SELECT id FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(0);
    // The feed is valid, just cloud-gated — it must NOT be soft-deleted.
    const [after] = await sql`SELECT deleted_at FROM feeds WHERE id = ${feedId}`;
    expect((after as { deleted_at: Date | null }).deleted_at).toBeNull();
  });

  it('queues the run normally when not in cloud mode (self-hosted)', async () => {
    const sql = getTestDb();
    const feedId = await setupPostgresFeed();

    process.env.LOBU_CLOUD_MODE = undefined;
    const runId = await createSyncRun(feedId, {} as Env, sql);

    expect(runId).not.toBeNull();
    const runs = await sql`SELECT status FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(1);
  });
});
