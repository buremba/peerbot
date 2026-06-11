/**
 * Cloud gate on the postgres sync path, both layers:
 *  - CREATION (createSyncRun): under LOBU_CLOUD_MODE a postgres run is never
 *    queued; the feed is left intact (valid, just cloud-gated), not soft-deleted.
 *  - EXECUTION (pollWorkerJob): a run already in `pending` (e.g. queued before
 *    cloud mode flipped, or via another path) must be FAILED when a worker claims
 *    it under LOBU_CLOUD_MODE — the hard boundary, since createSyncRun alone can
 *    be bypassed. Self-hosted (cloud mode off) runs normally on both layers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createSyncRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';

const CONNECTOR_VERSION = '1.0.0';

async function setupPostgresFeed(): Promise<{ feedId: number; connId: number; orgId: string }> {
  const sql = getTestDb();
  const org = await createTestOrganization();
  await createTestConnectorDefinition({
    key: 'postgres',
    name: 'PostgreSQL',
    version: CONNECTOR_VERSION,
    organization_id: org.id,
  });
  // A non-device-pinned, active connection with required_capability NULL — so a
  // fleet worker poll (branch 1A) can claim its run and reach the gate.
  const conn = await createTestConnection({
    organization_id: org.id,
    connector_key: 'postgres',
  });
  const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${conn.id}`;
  return { feedId: Number((feed as { id: number }).id), connId: conn.id, orgId: org.id };
}

/** Insert a `pending` postgres sync run directly, bypassing createSyncRun's
 *  queue-time gate, so the worker-poll execution gate is what's under test. */
async function insertPendingPostgresRun(
  orgId: string,
  feedId: number,
  connId: number
): Promise<number> {
  const sql = getTestDb();
  const [run] = await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id, connector_key, connector_version,
      status, approval_status, created_at
    ) VALUES (
      ${orgId}, 'sync', ${feedId}, ${connId}, 'postgres', ${CONNECTOR_VERSION},
      'pending', 'auto', current_timestamp
    )
    RETURNING id
  `;
  return Number((run as { id: number }).id);
}

describe('createSyncRun cloud gate (postgres) — queue-time', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('does NOT queue a postgres sync run under LOBU_CLOUD_MODE (feed left intact)', async () => {
    const sql = getTestDb();
    const { feedId } = await setupPostgresFeed();

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
    const { feedId } = await setupPostgresFeed();

    process.env.LOBU_CLOUD_MODE = undefined;
    const runId = await createSyncRun(feedId, {} as Env, sql);

    expect(runId).not.toBeNull();
    const runs = await sql`SELECT status FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(1);
  });
});

describe('pollWorkerJob cloud gate (postgres) — execution-time', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('FAILS a claimed postgres run under LOBU_CLOUD_MODE instead of handing it to a worker', async () => {
    const sql = getTestDb();
    const { feedId, connId, orgId } = await setupPostgresFeed();
    const runId = await insertPendingPostgresRun(orgId, feedId, connId);

    process.env.LOBU_CLOUD_MODE = '1';
    try {
      // #1192 fails anonymous workers-API calls closed (401) under cloud mode,
      // so authenticate as a trusted fleet worker — the execution-time gate
      // inside pollWorkerJob is what this test is about.
      const res = await post('/api/workers/poll', {
        body: { worker_id: 'cloud-gate-worker', capabilities: {} },
        token: 'test-fleet-token',
        env: { WORKER_API_TOKEN: 'test-fleet-token' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run_id?: number;
        skipped_run_id?: number;
        error?: string;
      };
      // The run was claimed, then the gate failed it — not dispatched.
      expect(body.run_id).toBeUndefined();
      expect(Number(body.skipped_run_id)).toBe(runId);
      expect(String(body.error)).toMatch(/Lobu Cloud/i);
    } finally {
      process.env.LOBU_CLOUD_MODE = undefined;
    }

    const [row] = await sql`
      SELECT status, error_message, completed_at FROM runs WHERE id = ${runId}
    `;
    expect((row as { status: string }).status).toBe('failed');
    expect((row as { completed_at: Date | null }).completed_at).not.toBeNull();
    expect(String((row as { error_message: string }).error_message)).toMatch(/Lobu Cloud/i);
  });

  it('claims the run for a worker when not in cloud mode (proves the gate, not the harness, fails it)', async () => {
    const sql = getTestDb();
    const { feedId, connId, orgId } = await setupPostgresFeed();
    const runId = await insertPendingPostgresRun(orgId, feedId, connId);

    process.env.LOBU_CLOUD_MODE = undefined;
    const res = await post('/api/workers/poll', {
      body: { worker_id: 'self-hosted-worker', capabilities: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(Number(body.run_id)).toBe(runId);

    const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect((row as { status: string }).status).toBe('running');
  });
});
