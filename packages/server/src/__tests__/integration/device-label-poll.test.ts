/**
 * `device_workers.label` lifecycle: the label is set at first registration (or
 * child-token mint) and after that belongs to the user via
 * `PATCH /api/me/devices/:id`. A poll heartbeat must never overwrite it — the
 * headless daemon reports its hostname as `label` on every poll, which used to
 * clobber a rename made on the Devices page seconds earlier.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken, hashToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';
import { TestWorkspace } from '../setup/test-mcp-client';

async function createWorkerBoundPat(
  userId: string,
  organizationId: string,
  workerId: string
): Promise<{ token: string }> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${hashToken(token)}, ${token.substring(0, 12)}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, 'device_worker:run', ${workerId},
      NOW(), NOW()
    )
  `;
  return { token };
}

describe('device_workers.label vs poll registration', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a poll heartbeat cannot overwrite a stored device label', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Label Poll Org' });
    const ownerUserId = workspace.users.owner.id;

    // A label the user set (Devices page PATCH lands exactly this state).
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${ownerUserId}, 'label-keeper', 'headless', ${sql.json({ 'os.shell': true })}, 'My build box', ${workspace.org.id})
    `;
    const { token } = await createWorkerBoundPat(
      ownerUserId,
      workspace.org.id,
      'label-keeper'
    );

    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'label-keeper',
        platform: 'headless',
        app_version: 'test',
        label: 'daemon-reported-hostname',
        capabilities: { 'os.shell': true },
      },
    });
    expect(pollRes.status).toBe(200);

    const rows = (await sql`
      SELECT label FROM device_workers WHERE worker_id = 'label-keeper'
    `) as unknown as Array<{ label: string | null }>;
    expect(rows[0].label).toBe('My build box');
  });

  it('first poll registration still records the reported label', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Label Insert Org' });
    const ownerUserId = workspace.users.owner.id;
    const { token } = await createWorkerBoundPat(
      ownerUserId,
      workspace.org.id,
      'label-fresh'
    );

    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'label-fresh',
        platform: 'headless',
        app_version: 'test',
        label: 'herdr-box-1',
        capabilities: { 'os.shell': true },
      },
    });
    expect(pollRes.status).toBe(200);

    const rows = (await sql`
      SELECT label FROM device_workers WHERE worker_id = 'label-fresh'
    `) as unknown as Array<{ label: string | null }>;
    expect(rows[0].label).toBe('herdr-box-1');
  });
});
