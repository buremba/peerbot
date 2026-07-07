/**
 * manage_entity `merge` action — the tool surface a watcher's agent (or an admin)
 * calls to fuse two entities. Covers the gate (admin/owner only), the org fence
 * (no cross-tenant / deleted target), and the happy path delegating to applyMerge.
 * The fusion mechanics themselves are proven in events/entity-merge.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageEntity } from '../../../tools/admin/manage_entity';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const env = {} as Env;

function ctx(orgId: string, userId: string, memberRole: string): ToolContext {
  // Full MCP scopes so the action-router's scope gate passes; the test asserts
  // the ROLE gate (admin/owner) inside the handler, not the scope tier.
  return {
    organizationId: orgId,
    userId,
    memberRole,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
  } as ToolContext;
}

describe('manage_entity merge action', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function twoEntities(orgId: string, userId: string) {
    const winner = await createTestEntity({
      name: 'Winner',
      entity_type: 'person',
      organization_id: orgId,
      created_by: userId,
    });
    const loser = await createTestEntity({
      name: 'Loser',
      entity_type: 'person',
      organization_id: orgId,
      created_by: userId,
    });
    return { winner, loser };
  }

  it('an owner merges the loser into the winner (loser tombstoned + forwarded)', async () => {
    const org = await createTestOrganization({ name: 'Merge Tool Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const { winner, loser } = await twoEntities(org.id, user.id);

    const res = (await manageEntity(
      { action: 'merge', entity_id: loser.id, winner_entity_id: winner.id },
      env,
      ctx(org.id, user.id, 'owner')
    )) as { action: string; success: boolean; winner_entity_id: number; loser_entity_id: number };

    expect(res.action).toBe('merge');
    expect(res.success).toBe(true);
    expect(res.winner_entity_id).toBe(winner.id);
    expect(res.loser_entity_id).toBe(loser.id);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `) as Array<{ merged_into: number | null; deleted_at: string | null }>;
    expect(Number(row.merged_into)).toBe(winner.id);
    expect(row.deleted_at).not.toBeNull();
  });

  it('rejects a non-admin member (403)', async () => {
    const org = await createTestOrganization({ name: 'Gate Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'member');
    const { winner, loser } = await twoEntities(org.id, user.id);

    await expect(
      manageEntity(
        { action: 'merge', entity_id: loser.id, winner_entity_id: winner.id },
        env,
        ctx(org.id, user.id, 'member')
      )
    ).rejects.toThrow(/admin or owner/i);
  });

  it('rejects a winner from another org (org fence, 404)', async () => {
    const orgA = await createTestOrganization({ name: 'Org A' });
    const orgB = await createTestOrganization({ name: 'Org B' });
    const userA = await createTestUser();
    const userB = await createTestUser();
    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');
    const loser = await createTestEntity({
      name: 'A-loser',
      entity_type: 'person',
      organization_id: orgA.id,
      created_by: userA.id,
    });
    const foreignWinner = await createTestEntity({
      name: 'B-winner',
      entity_type: 'person',
      organization_id: orgB.id,
      created_by: userB.id,
    });

    await expect(
      manageEntity(
        { action: 'merge', entity_id: loser.id, winner_entity_id: foreignWinner.id },
        env,
        ctx(orgA.id, userA.id, 'owner')
      )
    ).rejects.toThrow(/not found in this workspace/i);
  });
});
