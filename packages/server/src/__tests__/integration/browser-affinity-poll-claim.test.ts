/**
 * Browser-affinity claim rules (PR #1826):
 *
 * When a connector outside the `chrome` / `chrome.*` native namespace is
 * pinned to a chrome-extension device, that pin means "scrape with this
 * browser", NOT "run the parent sync on the extension". Fleet claims parent
 * sync; the extension must not.
 *
 * Native Chrome connectors execute on the extension when pinned. The narrow
 * legacy-key exception additionally requires the selected run artifact to
 * be the validated Chrome device manifest; the key alone is not placement.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnectorDefinition } from '../setup/test-fixtures';
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
  connectorVersion?: string | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      connector_version, approval_status, status, created_at
    ) VALUES (
      ${opts.orgId}, 'sync', ${opts.connectionId}, ${opts.connectorKey},
      ${opts.connectorVersion ?? null}, 'auto', 'pending', current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedPendingAction(opts: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  expiresAtAgoSeconds?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      action_key, action_input, approval_status, status, created_at, expires_at
    ) VALUES (
      ${opts.orgId}, 'action', ${opts.connectionId}, ${opts.connectorKey},
      'open_tab', ${sql.json({})}, 'auto', 'pending', current_timestamp,
      ${opts.expiresAtAgoSeconds == null
        ? null
        : sql`current_timestamp - make_interval(secs => ${opts.expiresAtAgoSeconds})`}
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

async function pollFleet(
  workerId = 'fleet-affinity-worker',
  capabilities: Record<string, boolean> = {}
) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities },
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

  it('treats a chrome-prefix lookalike as delegated affinity, not native execution', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chromecast.demo',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'chromecast.demo',
    });

    const extensionResponse = await pollExtension(workerId);
    expect(extensionResponse.status).toBe(200);
    expect(((await extensionResponse.json()) as { run_id?: number }).run_id).toBeUndefined();

    const fleetResponse = await pollFleet('fleet-chrome-prefix-affinity');
    expect(fleetResponse.status).toBe(200);
    const fleetBody = (await fleetResponse.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    expect(Number(fleetBody.run_id ?? fleetBody.skipped_run_id)).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe('fleet-chrome-prefix-affinity');
  });

  it('keeps a compiled whatsapp.local artifact with stale manifest provenance on the fleet lane', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const sql = getTestDb();
    const connectorVersion = `compiled-${generateSecureToken(4)}`;
    await createTestConnectorDefinition({
      key: 'whatsapp.local',
      name: 'WhatsApp compiled override',
      version: connectorVersion,
      organization_id: orgId,
    });
    await sql`
      UPDATE connector_definitions
      SET required_capability = 'browser.scripting',
          runtime = ${sql.json({ platforms: ['chrome-extension'] })}
      WHERE organization_id = ${orgId}
        AND key = 'whatsapp.local'
        AND status = 'active'
    `;
    await sql`
      INSERT INTO connector_versions (
        organization_id, connector_key, version, compiled_code,
        compiled_code_hash, compile_config_hash, source_path, created_at
      ) VALUES (
        ${orgId}, 'whatsapp.local', ${connectorVersion},
        'module.exports = { sync: async () => ({ items: [] }) }',
        'org-compiled-whatsapp-hash', ${COMPILE_CONFIG_HASH},
        ${`device-manifest://chrome-extension/whatsapp.local@${connectorVersion}`}, NOW()
      )
    `;
    const connectionId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'whatsapp.local',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId,
      connectorKey: 'whatsapp.local',
      connectorVersion,
    });

    const extensionResponse = await pollExtension(workerId);
    expect(extensionResponse.status).toBe(200);
    const extensionBody = (await extensionResponse.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    expect(extensionBody.run_id).toBeUndefined();
    expect(extensionBody.skipped_run_id).toBeUndefined();

    const fleetResponse = await pollFleet('fleet-whatsapp-compiled-override', {
      'browser.scripting': true,
    });
    expect(fleetResponse.status).toBe(200);
    const fleetBody = (await fleetResponse.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    expect(Number(fleetBody.run_id ?? fleetBody.skipped_run_id)).toBe(runId);
    const [run] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(run.claimed_by).toBe('fleet-whatsapp-compiled-override');

    await sql`
      UPDATE runs SET status = 'completed', completed_at = NOW() WHERE id = ${runId}
    `;
    await sql`
      UPDATE connections SET device_worker_id = NULL WHERE id = ${connectionId}
    `;
    const unpinnedRunId = await seedPendingSync({
      orgId,
      connectionId,
      connectorKey: 'whatsapp.local',
      connectorVersion,
    });
    const unpinnedExtensionResponse = await pollExtension(workerId);
    expect(unpinnedExtensionResponse.status).toBe(200);
    expect(
      ((await unpinnedExtensionResponse.json()) as { run_id?: number }).run_id
    ).toBeUndefined();
    const unpinnedFleetResponse = await pollFleet('fleet-whatsapp-unpinned-compiled', {
      'browser.scripting': true,
    });
    expect(unpinnedFleetResponse.status).toBe(200);
    const unpinnedFleetBody = (await unpinnedFleetResponse.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    expect(Number(unpinnedFleetBody.run_id ?? unpinnedFleetBody.skipped_run_id)).toBe(
      unpinnedRunId
    );
  });

  it('does not let Chrome capability-claim a hashless manifest artifact without connector_manifests', async () => {
    const { userId, orgId } = await seedOrg();
    const { workerId } = await seedExtWorker(userId, orgId);
    const sql = getTestDb();
    const connectorKey = `test.hashless-chrome-${generateSecureToken(4)}`;
    const connectorVersion = '1.0.0';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Hashless Chrome manifest',
      version: connectorVersion,
      organization_id: orgId,
    });
    await sql`
      UPDATE connector_definitions
      SET required_capability = 'browser.scripting',
          runtime = ${sql.json({ platforms: ['chrome-extension'] })}
      WHERE organization_id = ${orgId}
        AND key = ${connectorKey}
        AND status = 'active'
    `;
    await sql`
      UPDATE connector_versions
      SET compiled_code = NULL,
          compiled_code_hash = NULL,
          compile_config_hash = NULL,
          source_code = NULL,
          source_path = ${`device-manifest://chrome-extension/${connectorKey}@${connectorVersion}`}
      WHERE connector_key = ${connectorKey}
        AND version = ${connectorVersion}
        AND organization_id IS NULL
    `;
    const connectionId = await seedConnection({
      orgId,
      userId,
      connectorKey,
      deviceWorkerId: null,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId,
      connectorKey,
      connectorVersion,
    });

    // This poll intentionally omits connector_manifests. A legacy capability
    // fallback must never authorize Chrome, even when the selected artifact
    // is hashless and declares the Chrome runtime.
    const response = await pollExtension(workerId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run_id?: number; skipped_run_id?: number };
    expect(body.run_id).toBeUndefined();
    expect(body.skipped_run_id).toBeUndefined();

    const [run] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(run).toEqual({ status: 'pending', claimed_by: null });
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

  it('chrome-extension does NOT claim an action run whose expires_at lapsed (ephemeral action horizon)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      expiresAtAgoSeconds: 60,
    });

    // Warm registration + claim attempt. The run is pending + auto-approved and
    // would otherwise match this device's claim branches — but its claim
    // horizon lapsed, so the poll must leave it untouched.
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

  it('chrome-extension still claims an action run with a live expires_at', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      // expires_at in the future → claimable
      expiresAtAgoSeconds: -60,
    });

    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    // chrome may fail-after-claim without compiled sources — either proves the
    // claim path reached this run.
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    expect(row.status).not.toBe('pending');
  });
});
