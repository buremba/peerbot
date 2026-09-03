import { beforeEach, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { PollResponseSchema } from '@lobu/core/contracts/worker/protocol';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

async function insertEmbedRun(organizationId: string, older = false) {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (organization_id, run_type, status, approval_status, created_at)
    VALUES (
      ${organizationId}, 'embed_backfill', 'pending', 'auto',
      ${older ? sql`current_timestamp - interval '1 minute'` : sql`current_timestamp`}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function runStatus(runId: number) {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, claimed_by FROM runs WHERE id = ${runId}
  `) as unknown as Array<{ status: string; claimed_by: string | null }>;
  return row;
}

async function pollFleet(workerId: string) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities: {} },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

describe('embed_backfill worker poll claim lane', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  it('trusted fleet claims a connectorless embed_backfill and emits a schema-valid response without connector_key', async () => {
    const org = await createTestOrganization();
    const runId = await insertEmbedRun(org.id);

    const response = await pollFleet('fleet-embed-response');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Value.Check(PollResponseSchema, body)).toBe(true);
    expect(body.run_id).toBe(runId);
    expect(body.run_type).toBe('embed_backfill');
    expect(Object.hasOwn(body, 'connector_key')).toBe(false);
    expect(await runStatus(runId)).toEqual({
      status: 'running',
      claimed_by: 'fleet-embed-response',
    });
  });

  it('two concurrent fleet polls claim one embed_backfill exactly once', async () => {
    const org = await createTestOrganization();
    const runId = await insertEmbedRun(org.id);

    const responses = await Promise.all([
      pollFleet('fleet-embed-race-a'),
      pollFleet('fleet-embed-race-b'),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter((body) => body.run_id === runId)).toHaveLength(1);
    expect(await runStatus(runId)).toMatchObject({ status: 'running' });
    expect(['fleet-embed-race-a', 'fleet-embed-race-b']).toContain(
      (await runStatus(runId)).claimed_by
    );
  });

  it('a user/device poll cannot claim a connectorless embed_backfill', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const workerId = 'device-embed-not-allowed';
    const sql = getTestDb();
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${user.id}, ${workerId}, 'macos', ${sql.json([])}, ${org.id})
    `;
    const pat = await createTestPAT(user.id, org.id, { scope: 'device_worker:run' });
    const runId = await insertEmbedRun(org.id);

    const response = await post('/api/workers/poll', {
      token: pat.token,
      body: { worker_id: workerId, platform: 'macos', capabilities: {} },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).run_id).toBeUndefined();
    expect(await runStatus(runId)).toEqual({ status: 'pending', claimed_by: null });
  });

  it('does not let an older embed_backfill block a later eligible device connector run', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const workerId = 'device-embed-hol';
    const sql = getTestDb();
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${user.id}, ${workerId}, 'macos', ${sql.json([])}, ${org.id})
    `;
    const pat = await createTestPAT(user.id, org.id, { scope: 'device_worker:run' });
    const embedId = await insertEmbedRun(org.id, true);
    const connectorKey = 'test.embed-hol';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Embed HOL Test',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: connectorKey,
    });
    const deviceId = (await sql`
      SELECT id FROM device_workers WHERE worker_id = ${workerId}
    `)[0].id;
    await sql`UPDATE connections SET device_worker_id = ${deviceId}::uuid WHERE id = ${connection.id}`;
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, connector_version,
        approval_status, status, created_at, target_device_worker_id
      )
      VALUES (${org.id}, 'sync', ${connection.id}, ${connectorKey}, '1.0.0', 'auto', 'pending', current_timestamp, ${deviceId}::uuid)
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const deviceResponse = await post('/api/workers/poll', {
      token: pat.token,
      body: { worker_id: workerId, platform: 'macos', capabilities: {} },
    });
    expect(deviceResponse.status).toBe(200);
    expect((await deviceResponse.json()).run_id).toBe(Number(run.id));
    expect(await runStatus(embedId)).toEqual({ status: 'pending', claimed_by: null });

    const fleetResponse = await pollFleet('fleet-embed-after-device');
    expect(fleetResponse.status).toBe(200);
    expect((await fleetResponse.json()).run_id).toBe(embedId);
    expect(await runStatus(embedId)).toEqual({
      status: 'running',
      claimed_by: 'fleet-embed-after-device',
    });
  });
});
