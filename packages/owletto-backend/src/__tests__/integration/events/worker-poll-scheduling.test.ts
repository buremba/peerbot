import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('Worker Poll Scheduling', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('materializes and claims at most one due sync run under concurrent polls', async () => {
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'Worker Poll Org' });

    await createTestConnectorDefinition({
      key: 'test.worker.poll',
      name: 'Worker Poll Connector',
      version: '1.0.0',
      feeds_schema: {
        mentions: { description: 'Mentions feed' },
      },
      organization_id: org.id,
    });

    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.worker.poll',
      status: 'active',
    });

    const insertedFeeds = await sql`
      INSERT INTO feeds (
        organization_id,
        connection_id,
        feed_key,
        status,
        schedule,
        next_run_at,
        created_at,
        updated_at
      ) VALUES (
        ${org.id},
        ${connection.id},
        'mentions',
        'active',
        '* * * * *',
        current_timestamp - INTERVAL '1 minute',
        current_timestamp,
        current_timestamp
      )
      RETURNING id
    `;
    const feedId = Number(insertedFeeds[0].id);

    const [responseA, responseB] = await Promise.all([
      post('/api/workers/poll', {
        body: { worker_id: 'worker-a', capabilities: { browser: false } },
      }),
      post('/api/workers/poll', {
        body: { worker_id: 'worker-b', capabilities: { browser: false } },
      }),
    ]);

    const bodyA = await responseA.json();
    const bodyB = await responseB.json();

    const runningBodies = [bodyA, bodyB].filter((body) => typeof body.run_id === 'number');
    const idleBodies = [bodyA, bodyB].filter((body) => body.next_poll_seconds === 10);

    expect(runningBodies).toHaveLength(1);
    expect(idleBodies).toHaveLength(1);
    expect(Number(runningBodies[0].feed_id)).toBe(feedId);
    expect(runningBodies[0].run_type).toBe('sync');

    const runs = await sql`
      SELECT id, status, claimed_by, feed_id
      FROM runs
      WHERE feed_id = ${feedId}
        AND run_type = 'sync'
      ORDER BY created_at ASC
    `;

    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('running');
    expect(Number(runs[0].feed_id)).toBe(feedId);
    expect(['worker-a', 'worker-b']).toContain(String(runs[0].claimed_by));

    const activeRuns = await sql`
      SELECT id
      FROM runs
      WHERE feed_id = ${feedId}
        AND run_type = 'sync'
        AND status IN ('pending', 'running')
    `;

    expect(activeRuns).toHaveLength(1);
  });
});
