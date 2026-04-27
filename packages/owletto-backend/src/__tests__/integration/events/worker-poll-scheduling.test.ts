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

  it('streams connector events without a human creator', async () => {
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'Worker Stream Org' });

    await createTestConnectorDefinition({
      key: 'test.worker.stream',
      name: 'Worker Stream Connector',
      version: '1.0.0',
      feeds_schema: {
        mentions: { description: 'Mentions feed' },
      },
      organization_id: org.id,
    });

    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.worker.stream',
      status: 'active',
    });

    const [feed] = await sql`
      INSERT INTO feeds (
        organization_id,
        connection_id,
        feed_key,
        status,
        created_at,
        updated_at
      ) VALUES (
        ${org.id},
        ${connection.id},
        'mentions',
        'active',
        current_timestamp,
        current_timestamp
      )
      RETURNING id
    `;

    const [run] = await sql`
      INSERT INTO runs (
        organization_id,
        run_type,
        feed_id,
        connection_id,
        connector_key,
        connector_version,
        status,
        approval_status,
        created_at
      ) VALUES (
        ${org.id},
        'sync',
        ${feed.id},
        ${connection.id},
        'test.worker.stream',
        '1.0.0',
        'running',
        'auto',
        current_timestamp
      )
      RETURNING id
    `;

    const response = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: 'source-item-1',
            title: 'Source item',
            payload_text: 'Connector-sourced content',
            source_url: 'https://example.com/source-item-1',
            occurred_at: new Date().toISOString(),
            score: 10,
          },
        ],
      },
    });

    expect(response.status).toBe(200);

    const events = await sql`
      SELECT created_by, connector_key, connection_id, feed_id, run_id, author_name
      FROM events
      WHERE origin_id = 'source-item-1'
        AND organization_id = ${org.id}
      LIMIT 1
    `;

    expect(events).toHaveLength(1);
    expect(events[0].created_by).toBeNull();
    expect(events[0].author_name).toBeNull();
    expect(events[0].connector_key).toBe('test.worker.stream');
    expect(Number(events[0].connection_id)).toBe(Number(connection.id));
    expect(Number(events[0].feed_id)).toBe(Number(feed.id));
    expect(Number(events[0].run_id)).toBe(Number(run.id));
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
