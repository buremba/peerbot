/**
 * Cloud gate on the postgres sync path, both layers — now OPEN for postgres.
 * `postgres` graduated out of CLOUD_RESTRICTED_CONNECTOR_KEYS (egress hardening:
 * block-private classify+reject, resolve-then-pin sockets, forced TLS), so:
 *  - CREATION (createSyncRun): a postgres run IS queued under LOBU_CLOUD_MODE.
 *  - EXECUTION (pollWorkerJob): a pending postgres run IS claimed and handed to
 *    a worker under LOBU_CLOUD_MODE (the run itself then executes under the
 *    injected block-private egress policy — covered by the connector tests).
 * These are regression tests that the gate stays open; the gate MECHANISM for
 * future warehouse connectors is covered by connector-cloud-gate.test.ts.
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

  it('queues a postgres sync run under LOBU_CLOUD_MODE (gate open)', async () => {
    const sql = getTestDb();
    const { feedId } = await setupPostgresFeed();

    process.env.LOBU_CLOUD_MODE = '1';
    const runId = await createSyncRun(feedId, {} as Env, sql);

    expect(runId).not.toBeNull();
    const runs = await sql`SELECT status FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(1);
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

  it('claims a postgres run for a worker under LOBU_CLOUD_MODE (gate open)', async () => {
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
      const body = (await res.json()) as { run_id?: number; error?: string };
      // The run is dispatched, not failed by the gate.
      expect(Number(body.run_id)).toBe(runId);
    } finally {
      process.env.LOBU_CLOUD_MODE = undefined;
    }

    const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect((row as { status: string }).status).toBe('running');
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
