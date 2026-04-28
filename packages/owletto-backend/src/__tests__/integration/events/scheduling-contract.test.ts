/**
 * Scheduler / worker ingestion contracts retained from deleted broad suites.
 *
 * These paths are high-value because they are production queue boundaries:
 * embed backfill must dedupe under concurrent ticks, worker stream must create
 * connector-owned events with no human creator, and worker polling must claim a
 * due sync run exactly once.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { triggerEmbedBackfill } from '../../../scheduled/trigger-embed-backfill';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('scheduler and worker ingestion contracts', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates at most one embed_backfill run with the missing event ids', async () => {
    const org = await createTestOrganization({ name: 'Backfill Contract Org' });
    const user = await createTestUser({ email: 'backfill-contract@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Backfill Entity', organization_id: org.id });

    for (let i = 0; i < 3; i++) {
      await createTestEvent({ entity_id: entity.id, content: `Missing embedding ${i}` });
    }

    const [resultA, resultB] = await Promise.all([
      triggerEmbedBackfill({} as Env),
      triggerEmbedBackfill({} as Env),
    ]);

    expect(resultA.runsCreated + resultB.runsCreated).toBe(1);

    const runs = await getTestDb()`
      SELECT status, action_input
      FROM runs
      WHERE organization_id = ${org.id}
        AND run_type = 'embed_backfill'
        AND status IN ('pending', 'running')
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('pending');

    const actionInput = runs[0].action_input as { event_ids?: unknown[] };
    expect(actionInput.event_ids).toHaveLength(3);
  });

  it('streams connector events without a human creator', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Worker Stream Contract Org' });

    await createTestConnectorDefinition({
      key: 'contract.worker.stream',
      name: 'Worker Stream Contract Connector',
      version: '1.0.0',
      feeds_schema: { mentions: { description: 'Mentions feed' } },
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'contract.worker.stream',
      status: 'active',
    });
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, created_at, updated_at)
      VALUES (${org.id}, ${connection.id}, 'mentions', 'active', current_timestamp, current_timestamp)
      RETURNING id
    `;
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key, connector_version,
        status, approval_status, created_at
      ) VALUES (
        ${org.id}, 'sync', ${feed.id}, ${connection.id}, 'contract.worker.stream', '1.0.0',
        'running', 'auto', current_timestamp
      )
      RETURNING id
    `;

    const response = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: 'worker-stream-contract-item',
            title: 'Source item',
            payload_text: 'Connector-sourced content',
            source_url: 'https://example.com/source-item',
            occurred_at: new Date().toISOString(),
            score: 10,
          },
        ],
      },
    });
    expect(response.status).toBe(200);

    const events = await sql`
      SELECT created_by, author_name, connector_key, connection_id, feed_id, run_id
      FROM events
      WHERE origin_id = 'worker-stream-contract-item'
        AND organization_id = ${org.id}
      LIMIT 1
    `;
    expect(events).toHaveLength(1);
    expect(events[0].created_by).toBeNull();
    expect(events[0].author_name).toBeNull();
    expect(events[0].connector_key).toBe('contract.worker.stream');
    expect(Number(events[0].connection_id)).toBe(Number(connection.id));
    expect(Number(events[0].feed_id)).toBe(Number(feed.id));
    expect(Number(events[0].run_id)).toBe(Number(run.id));
  });

  it('materializes and claims a due sync run exactly once under concurrent polls', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Worker Poll Contract Org' });

    await createTestConnectorDefinition({
      key: 'contract.worker.poll',
      name: 'Worker Poll Contract Connector',
      version: '1.0.0',
      feeds_schema: { mentions: { description: 'Mentions feed' } },
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'contract.worker.poll',
      status: 'active',
    });
    const [feed] = await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, schedule, next_run_at, created_at, updated_at
      ) VALUES (
        ${org.id}, ${connection.id}, 'mentions', 'active', '* * * * *',
        current_timestamp - INTERVAL '1 minute', current_timestamp, current_timestamp
      )
      RETURNING id
    `;

    const [responseA, responseB] = await Promise.all([
      post('/api/workers/poll', { body: { worker_id: 'worker-a', capabilities: { browser: false } } }),
      post('/api/workers/poll', { body: { worker_id: 'worker-b', capabilities: { browser: false } } }),
    ]);
    const bodies = [await responseA.json(), await responseB.json()];
    const running = bodies.filter((body) => typeof body.run_id === 'number');
    const idle = bodies.filter((body) => body.next_poll_seconds === 10);

    expect(running).toHaveLength(1);
    expect(idle).toHaveLength(1);
    expect(Number(running[0].feed_id)).toBe(Number(feed.id));
    expect(running[0].run_type).toBe('sync');

    const runs = await sql`
      SELECT status, claimed_by, feed_id
      FROM runs
      WHERE feed_id = ${feed.id}
        AND run_type = 'sync'
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('running');
    expect(['worker-a', 'worker-b']).toContain(String(runs[0].claimed_by));
  });
});
