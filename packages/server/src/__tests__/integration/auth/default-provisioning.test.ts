/**
 * Integration tests for `auth/default-provisioning.ts`.
 *
 * Pins the sentinel behavior pi flagged: deletion stickiness (a removed
 * agent / watcher is NOT auto-recreated on the next run), provisioning
 * timing (watcher creation requires a device row), and idempotency.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../../auth/oauth/utils';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_SENTINEL,
  DEFAULT_WATCHER_SENTINEL,
  DEFAULT_WATCHER_SLUG,
  ensureDefaultAgent,
  ensureDefaultWatcher,
  hasOrgSentinel,
} from '../../../auth/default-provisioning';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

async function seedOrg(orgId: string): Promise<void> {
  const sql = getTestDb();
  const slug = orgId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
    VALUES (${orgId}, ${orgId}, ${slug}, 'private', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function readMetadata(orgId: string): Promise<Record<string, unknown>> {
  const sql = getTestDb();
  const rows = await sql`
    SELECT metadata FROM "organization" WHERE id = ${orgId} LIMIT 1
  `;
  const raw = rows[0]?.metadata as string | null | undefined;
  if (!raw) return {};
  return JSON.parse(raw);
}

describe('ensureDefaultAgent', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates the default agent and writes the sentinel', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(true);
    expect(result.reason).toBe('inserted');

    const sql = getTestDb();
    const agents = await sql`
      SELECT id, name FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(1);
    expect(String(agents[0].id)).toBe(DEFAULT_AGENT_ID);
    expect(String(agents[0].name)).toBe('Owletto Personal');

    const metadata = await readMetadata(orgId);
    expect(metadata[DEFAULT_AGENT_SENTINEL]).toBeDefined();
  });

  it('is idempotent — second call is a no-op', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const first = await ensureDefaultAgent(orgId);
    expect(first.created).toBe(true);

    const second = await ensureDefaultAgent(orgId);
    expect(second.created).toBe(false);
    expect(second.reason).toBe('sentinel');
  });

  it('is sticky against deletion — recreate refused after sentinel set', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    await ensureDefaultAgent(orgId);

    // User deletes the agent via the web UI.
    const sql = getTestDb();
    await sql`
      DELETE FROM agents WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;

    const again = await ensureDefaultAgent(orgId);
    expect(again.created).toBe(false);
    expect(again.reason).toBe('sentinel');

    const agents = await sql`
      SELECT id FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(0);
  });

  it('skips creation (but stamps sentinel) when other agents already exist', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    // The user already curated their own agent before Owletto ever provisioned.
    const sql = getTestDb();
    await sql`
      INSERT INTO agents (id, organization_id, name)
      VALUES ('user-curated', ${orgId}, 'User-Curated Agent')
    `;

    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('has_agents');

    const agents = await sql`
      SELECT id FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(1);
    expect(String(agents[0].id)).toBe('user-curated');

    // Sentinel still set so the next boot doesn't keep re-checking.
    expect(await hasOrgSentinel(orgId, DEFAULT_AGENT_SENTINEL)).toBe(true);
  });
});

describe('ensureDefaultWatcher', () => {
  async function setupOrgWithDeviceAndAgent(): Promise<{
    orgId: string;
    deviceWorkerId: string;
    userId: string;
  }> {
    const orgId = `org-watcher-${generateSecureToken(4)}`;
    await seedOrg(orgId);
    const sql = getTestDb();

    const userId = `user_${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Watcher User', ${`${userId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // Add the user as the org owner so `watchers.created_by` has a valid FK target.
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${`member_${generateSecureToken(4)}`}, ${userId}, ${orgId}, 'owner', NOW())
    `;
    const inserted = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${`worker-${userId}`}, 'macos', ${sql.json({})}, 'Mac', ${orgId})
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceWorkerId = String(inserted[0].id);

    // Pre-provision the default agent (the order ensureDefaultAgent enforces).
    await ensureDefaultAgent(orgId);

    return { orgId, deviceWorkerId, userId };
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates the daily-checkin watcher pinned to the device', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(true);
    expect(result.reason).toBe('inserted');

    const sql = getTestDb();
    const watchers = await sql`
      SELECT id, slug, agent_id, device_worker_id::text AS device_worker_id, schedule, status
      FROM watchers
      WHERE organization_id = ${orgId}
    `;
    expect(watchers).toHaveLength(1);
    const w = watchers[0];
    expect(String(w.slug)).toBe(DEFAULT_WATCHER_SLUG);
    expect(String(w.agent_id)).toBe(DEFAULT_AGENT_ID);
    expect(String(w.device_worker_id)).toBe(deviceWorkerId);
    expect(String(w.schedule)).toBe('0 9 * * *');
    expect(String(w.status)).toBe('active');

    const versions = await sql`
      SELECT prompt FROM watcher_versions WHERE watcher_id = ${w.id}
    `;
    expect(versions).toHaveLength(1);
    expect(String(versions[0].prompt)).toMatch(/yesterday/i);

    expect(await hasOrgSentinel(orgId, DEFAULT_WATCHER_SENTINEL)).toBe(true);
  });

  it('is idempotent — second call is a no-op', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    const first = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(first.created).toBe(true);

    const second = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(second.created).toBe(false);
    expect(second.reason).toBe('sentinel');

    const sql = getTestDb();
    const watchers = await sql`SELECT id FROM watchers WHERE organization_id = ${orgId}`;
    expect(watchers).toHaveLength(1);
  });

  it('is sticky against deletion — recreate refused after sentinel set', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });

    const sql = getTestDb();
    await sql`DELETE FROM watchers WHERE organization_id = ${orgId} AND slug = ${DEFAULT_WATCHER_SLUG}`;

    const again = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(again.created).toBe(false);
    expect(again.reason).toBe('sentinel');

    const watchers = await sql`SELECT id FROM watchers WHERE organization_id = ${orgId}`;
    expect(watchers).toHaveLength(0);
  });

  it('falls back to another agent when the default has been deleted', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();
    const sql = getTestDb();

    // User deleted the default agent before the device first registered.
    await sql`DELETE FROM agents WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}`;
    await sql`
      INSERT INTO agents (id, organization_id, name)
      VALUES ('fallback-agent', ${orgId}, 'Fallback')
    `;

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(true);

    const watchers = await sql`
      SELECT agent_id FROM watchers WHERE organization_id = ${orgId}
    `;
    expect(watchers).toHaveLength(1);
    expect(String(watchers[0].agent_id)).toBe('fallback-agent');
  });

  it('skips silently when the org has no agents at all', async () => {
    const orgId = `org-watcher-noagent-${generateSecureToken(4)}`;
    await seedOrg(orgId);
    const sql = getTestDb();
    const userId = `user_${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'No Agent User', ${`${userId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${`member_${generateSecureToken(4)}`}, ${userId}, ${orgId}, 'owner', NOW())
    `;
    const inserted = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${`worker-${userId}`}, 'macos', ${sql.json({})}, 'Mac', ${orgId})
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceWorkerId = String(inserted[0].id);

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no_agent');

    // Sentinel still set so we don't keep retrying on every poll.
    expect(await hasOrgSentinel(orgId, DEFAULT_WATCHER_SENTINEL)).toBe(true);
  });
});
