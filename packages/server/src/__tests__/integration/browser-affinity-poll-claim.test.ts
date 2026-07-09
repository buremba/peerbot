/**
 * Browser-affinity claim rules (PR #1826):
 *
 * When a non-chrome* connection (LinkedIn/X/…) is pinned to a chrome-extension
 * device, that pin means "scrape with this browser", NOT "run the parent sync
 * on the extension". Fleet claims parent sync; the extension must not.
 *
 * chrome* connectors still execute on the extension when pinned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const DEBUGGER_CAPS = ['browser.tabs', 'browser.scripting', 'browser.debugger'];

async function seedOrg() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-aff-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Affinity Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Affinity Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  return { userId, orgId };
}

async function seedExtWorker(userId: string, orgId: string): Promise<{
  deviceWorkerId: string;
  workerId: string;
}> {
  const sql = getTestDb();
  const workerId = `ext-${generateSecureToken(6)}`;
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at
    ) VALUES (
      ${userId}, ${workerId}, 'chrome-extension', '0.1.0',
      ${sql.json(DEBUGGER_CAPS)}, 'Test Ext', ${orgId}, NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { deviceWorkerId: String(row.id), workerId };
}

async function seedConnection(opts: {
  orgId: string;
  userId: string;
  connectorKey: string;
  deviceWorkerId: string | null;
}): Promise<number> {
  const sql = getTestDb();
  const slug = `${opts.connectorKey}-${generateSecureToken(4)}`.replace(/\./g, '-');
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, device_worker_id, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectorKey}, ${slug}, ${opts.connectorKey}, 'active',
      ${opts.userId}, 'private', ${opts.deviceWorkerId}::uuid, NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedPendingSync(opts: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      approval_status, status, created_at
    ) VALUES (
      ${opts.orgId}, 'sync', ${opts.connectionId}, ${opts.connectorKey},
      'auto', 'pending', current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function pollExtension(workerId: string) {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'chrome-extension',
      app_version: '0.1.0',
      label: 'Test Ext',
      capabilities: {
        'browser.tabs': true,
        'browser.scripting': true,
        'browser.debugger': true,
      },
    },
  });
}

async function pollFleet(workerId = 'fleet-affinity-worker') {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities: {} },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

describe('browser-affinity poll claim', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });

  it('fleet claims a LinkedIn sync pinned to a chrome-extension (browser affinity)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'linkedin',
    });

    const res = await pollFleet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
      connector_key?: string;
    };
    // Claimed by fleet. Without on-disk linkedin connector sources the poll
    // may fail-after-claim with skipped_run_id — either proves the claim path.
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe('fleet-affinity-worker');
  });

  it('chrome-extension does NOT claim a LinkedIn sync pinned to itself (affinity, not job host)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'linkedin',
    });

    // Warm registration + claim attempt
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(row.status).toBe('pending');
    expect(row.claimed_by).toBeNull();
  });

  it('chrome-extension still claims a chrome connector sync pinned to itself', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
    });

    // Register + claim. chrome may fail-after-claim without compiled sources.
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
      connector_key?: string;
    };
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe(workerId);
  });

  it('fleet does NOT claim a macos-pinned non-browser-affinity sync (no regression)', async () => {
    const sql = getTestDb();
    const { userId, orgId } = await seedOrg();
    const workerId = `mac-${generateSecureToken(6)}`;
    const [mac] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${userId}, ${workerId}, 'macos', '0.1.0',
        ${sql.json(['whatsapp_local'])}, 'Mac', ${orgId}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'whatsapp.local',
      deviceWorkerId: String(mac.id),
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'whatsapp.local',
    });

    const res = await pollFleet('fleet-no-macos-steal');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(body.run_id).toBeUndefined();

    const [row] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('pending');
  });
});
