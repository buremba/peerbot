/**
 * resolveDeviceClaimableOrgs — cross-org device pin scoping.
 *
 * A user-scoped device worker's base scope is [token's bound org, personal org].
 * This helper widens it to orgs where the device has an active pin AND its owner
 * is still a member. Pinning is the owner's consent (see watcher-device-access);
 * the membership join revokes scope when the owner leaves the org.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveDeviceClaimableOrgs } from '../../../utils/device-claimable-orgs';
import { getNextNumericId } from '../../../tools/admin/helpers/db-helpers';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

async function insertDevice(userId: string, orgId: string): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
  const rows = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, 'macos', ${sql.json({})}, 'Test Mac', ${orgId})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(rows[0].id);
}

async function pinWatcher(opts: {
  orgId: string;
  agentId: string;
  deviceWorkerId: string;
  createdBy: string;
  status?: string;
}): Promise<void> {
  const id = await getNextNumericId(sql, 'watchers');
  await sql`
    INSERT INTO watchers (
      id, status, created_by, organization_id, agent_id, watcher_group_id,
      notification_channel, notification_priority, min_cooldown_seconds,
      device_worker_id, slug, created_at, updated_at
    ) VALUES (
      ${id}, ${opts.status ?? 'active'}, ${opts.createdBy}, ${opts.orgId}, ${opts.agentId}, ${id},
      'notification', 'normal', 300, ${opts.deviceWorkerId}, ${`w-${id}`}, NOW(), NOW()
    )
  `;
}

describe('resolveDeviceClaimableOrgs (cross-org device pins)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('adds an org with an active pin when the owner is a member, and excludes a non-member org', async () => {
    const user = await createTestUser();
    const orgA = await createTestOrganization(); // base scope (bound/personal)
    const orgB = await createTestOrganization(); // member + pinned -> included
    const orgC = await createTestOrganization(); // pinned but NOT a member -> excluded
    await addUserToOrganization(user.id, orgA.id, 'owner');
    await addUserToOrganization(user.id, orgB.id, 'owner');
    // intentionally NOT a member of orgC

    const deviceWorkerId = await insertDevice(user.id, orgA.id);
    const agentB = await createTestAgent({ organizationId: orgB.id, ownerUserId: user.id });
    const agentC = await createTestAgent({ organizationId: orgC.id, ownerUserId: user.id });
    await pinWatcher({ orgId: orgB.id, agentId: agentB.agentId, deviceWorkerId, createdBy: user.id });
    await pinWatcher({ orgId: orgC.id, agentId: agentC.agentId, deviceWorkerId, createdBy: user.id });

    const result = await resolveDeviceClaimableOrgs(sql, {
      deviceWorkerId,
      ownerUserId: user.id,
      baseOrgIds: [orgA.id],
    });

    expect(result).toContain(orgA.id); // base scope always present
    expect(result).toContain(orgB.id); // pinned + member
    expect(result).not.toContain(orgC.id); // pinned but not a member
  });

  it('does not grant scope from an archived watcher pin', async () => {
    const user = await createTestUser();
    const orgA = await createTestOrganization();
    const orgB = await createTestOrganization();
    await addUserToOrganization(user.id, orgA.id, 'owner');
    await addUserToOrganization(user.id, orgB.id, 'owner');

    const deviceWorkerId = await insertDevice(user.id, orgA.id);
    const agentB = await createTestAgent({ organizationId: orgB.id, ownerUserId: user.id });
    await pinWatcher({
      orgId: orgB.id,
      agentId: agentB.agentId,
      deviceWorkerId,
      createdBy: user.id,
      status: 'archived',
    });

    const result = await resolveDeviceClaimableOrgs(sql, {
      deviceWorkerId,
      ownerUserId: user.id,
      baseOrgIds: [orgA.id],
    });

    expect(result).toEqual([orgA.id]); // archived pin grants nothing
  });
});
