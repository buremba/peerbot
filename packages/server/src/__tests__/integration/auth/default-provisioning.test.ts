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

  it('stamps owner_user_id + models + agent_users on insert', async () => {
    const orgId = `org-owner-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    // Mark the org as personal_org_for_user_id = <ownerUserId> — this is the
    // marker ensureDefaultAgent reads to figure out who the agent belongs to.
    const ownerUserId = `user_${generateSecureToken(4)}`;
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${ownerUserId}, 'Owner', ${`${ownerUserId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      UPDATE "organization"
         SET metadata = ${JSON.stringify({ personal_org_for_user_id: ownerUserId })}
       WHERE id = ${orgId}
    `;

    await ensureDefaultAgent(orgId);

    const rows = await sql`
      SELECT owner_platform, owner_user_id, models
        FROM agents
       WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].owner_platform)).toBe('external');
    expect(String(rows[0].owner_user_id)).toBe(ownerUserId);
    // models shape: ordered array of explicit "<slug>/<model>" refs. We don't
    // pin a count because system keys depend on test env vars; we just assert
    // the column is a JSON array of provider-qualified refs (never null/
    // empty-string, never "auto").
    expect(Array.isArray(rows[0].models)).toBe(true);
    for (const ref of rows[0].models as string[]) {
      expect(ref.includes('/')).toBe(true);
      expect(ref.split('/').slice(1).join('/')).not.toBe('auto');
    }

    const userAgents = await sql`
      SELECT platform, user_id
        FROM agent_users
       WHERE organization_id = ${orgId} AND agent_id = ${DEFAULT_AGENT_ID}
    `;
    expect(userAgents).toHaveLength(1);
    expect(String(userAgents[0].platform)).toBe('external');
    expect(String(userAgents[0].user_id)).toBe(ownerUserId);
  });

  it('backfills owner + agent_users on a legacy row past the sentinel', async () => {
    // Simulate a legacy install: the row exists with the old
    // owner_platform='lobu', owner_user_id=NULL, no models shape, and the
    // sentinel is already set so the fast-path would skip.
    const orgId = `org-backfill-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const ownerUserId = `user_${generateSecureToken(4)}`;
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${ownerUserId}, 'Legacy Owner', ${`${ownerUserId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      UPDATE "organization"
         SET metadata = ${JSON.stringify({
           personal_org_for_user_id: ownerUserId,
           [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
         })}
       WHERE id = ${orgId}
    `;
    await sql`
      INSERT INTO agents (
        id, organization_id, name, owner_platform, owner_user_id,
        created_at, updated_at
      ) VALUES (
        ${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal',
        'lobu', NULL,
        NOW(), NOW()
      )
    `;

    // Sentinel is set, so the create path is short-circuited, but backfill
    // still runs.
    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('sentinel');

    const rows = await sql`
      SELECT owner_platform, owner_user_id
        FROM agents
       WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;
    expect(String(rows[0].owner_platform)).toBe('external');
    expect(String(rows[0].owner_user_id)).toBe(ownerUserId);

    const userAgents = await sql`
      SELECT user_id FROM agent_users
       WHERE organization_id = ${orgId} AND agent_id = ${DEFAULT_AGENT_ID}
    `;
    expect(userAgents).toHaveLength(1);
    expect(String(userAgents[0].user_id)).toBe(ownerUserId);
  });

  it('#6: an EMPTY models list ([]) survives a backfill pass unchanged (deliberate allow-all)', async () => {
    // [] = "allow all org + system-key providers", a valid deliberate policy.
    // The backfill must NOT treat it as broken and overwrite it.
    const orgId = `org-empty-allow-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const ownerUserId = `user_${generateSecureToken(4)}`;
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${ownerUserId}, 'Owner', ${`${ownerUserId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      UPDATE "organization"
         SET metadata = ${JSON.stringify({
           personal_org_for_user_id: ownerUserId,
           [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
         })}
       WHERE id = ${orgId}
    `;
    await sql`
      INSERT INTO agents (
        id, organization_id, name, owner_platform, owner_user_id,
        models, created_at, updated_at
      ) VALUES (
        ${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal',
        'external', ${ownerUserId},
        '[]'::jsonb,
        NOW(), NOW()
      )
    `;

    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(false);

    const rows = await sql`
      SELECT models FROM agents
       WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;
    // The deliberate empty allow-all list is preserved, never re-populated.
    expect(rows[0].models).toEqual([]);
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
