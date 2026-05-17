/**
 * manage_goals CRUD via the SDK surface.
 *
 * Covers create / get / update / list / archive / delete and the cross-org
 * isolation paths. Also asserts the watchers.goal_id FK behavior:
 *   - watchers may link to a goal at create or update time;
 *   - deleting a goal nulls out the watcher's `goal_id` (ON DELETE SET NULL)
 *     rather than cascading;
 *   - deleting the parent org cascades the goal away cleanly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('goals CRUD', () => {
  let owner: TestApiClient;
  let intruder: TestApiClient;
  let agentId: string;
  let organizationId: string;
  let intruderOrgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Goals Test Org' });
    organizationId = org.id;
    const user = await createTestUser({ email: 'goals-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    agentId = agent.agentId;

    const otherOrg = await createTestOrganization({ name: 'Goals Other Org' });
    intruderOrgId = otherOrg.id;
    const otherUser = await createTestUser({ email: 'goals-other@test.com' });
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
    intruder = await TestApiClient.for({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      memberRole: 'owner',
    });
  });

  it('creates → reads back → updates → archives → deletes a goal', async () => {
    const created = (await owner.goals.create({
      slug: 'crm-hygiene',
      name: 'Keep CRM clean',
      description: 'Daily checks on stale leads.',
      template_key: 'templates/crm-hygiene',
      metadata: { color: 'emerald' },
    })) as { action: 'create'; goal: { id: number; slug: string; status: string } };
    expect(created.goal.id).toBeDefined();
    expect(created.goal.slug).toBe('crm-hygiene');
    expect(created.goal.status).toBe('active');

    const got = (await owner.goals.get({ goal_id: created.goal.id })) as {
      goal: { name: string; metadata: Record<string, unknown> };
    };
    expect(got.goal.name).toBe('Keep CRM clean');
    expect(got.goal.metadata).toEqual({ color: 'emerald' });

    // Merge semantics: passing metadata without replace_metadata merges.
    await owner.goals.update({
      goal_id: created.goal.id,
      name: 'Keep CRM tidy',
      metadata: { icon: 'broom' },
    });
    const afterUpdate = (await owner.goals.get({ slug: 'crm-hygiene' })) as {
      goal: { name: string; metadata: Record<string, unknown> };
    };
    expect(afterUpdate.goal.name).toBe('Keep CRM tidy');
    expect(afterUpdate.goal.metadata).toEqual({ color: 'emerald', icon: 'broom' });

    // Replace semantics: replace_metadata wipes the prior keys.
    await owner.goals.update({
      goal_id: created.goal.id,
      metadata: { color: 'red' },
      replace_metadata: true,
    });
    const afterReplace = (await owner.goals.get({ goal_id: created.goal.id })) as {
      goal: { metadata: Record<string, unknown> };
    };
    expect(afterReplace.goal.metadata).toEqual({ color: 'red' });

    const archived = (await owner.goals.archive({ goal_id: created.goal.id })) as {
      goal: { status: string };
    };
    expect(archived.goal.status).toBe('archived');

    const deleted = (await owner.goals.delete({ goal_id: created.goal.id })) as {
      deleted: true;
    };
    expect(deleted.deleted).toBe(true);

    await expect(owner.goals.get({ goal_id: created.goal.id })).rejects.toThrow(/not found/i);
  });

  it('lists goals scoped to the caller org and filters by status', async () => {
    const a = (await owner.goals.create({ slug: 'active-1', name: 'Active 1' })) as {
      goal: { id: number };
    };
    const b = (await owner.goals.create({
      slug: 'paused-1',
      name: 'Paused 1',
      status: 'paused',
    })) as { goal: { id: number } };

    const allMine = (await owner.goals.list()) as {
      goals: Array<{ id: number; status: string }>;
    };
    const ids = allMine.goals.map((g) => g.id);
    expect(ids).toContain(a.goal.id);
    expect(ids).toContain(b.goal.id);

    const onlyPaused = (await owner.goals.list({ status: 'paused' })) as {
      goals: Array<{ id: number; status: string }>;
    };
    expect(onlyPaused.goals.every((g) => g.status === 'paused')).toBe(true);
    expect(onlyPaused.goals.some((g) => g.id === b.goal.id)).toBe(true);

    // Cleanup
    await owner.goals.delete({ goal_id: a.goal.id });
    await owner.goals.delete({ goal_id: b.goal.id });
  });

  it('blocks cross-org reads and writes', async () => {
    const created = (await owner.goals.create({
      slug: 'xorg-goal',
      name: 'Owner Goal',
    })) as { goal: { id: number; slug: string } };

    await expect(intruder.goals.get({ goal_id: created.goal.id })).rejects.toThrow(/not found/i);
    await expect(
      intruder.goals.update({ goal_id: created.goal.id, name: 'hijack' })
    ).rejects.toThrow(/not found/i);
    await expect(intruder.goals.delete({ goal_id: created.goal.id })).rejects.toThrow(/not found/i);

    await owner.goals.delete({ goal_id: created.goal.id });
  });

  it('rejects an invalid slug', async () => {
    await expect(
      owner.goals.create({ slug: 'BAD SLUG!', name: 'Invalid' })
    ).rejects.toThrow(/Invalid goal slug/);
  });

  it('rejects a duplicate slug in the same org via the UNIQUE constraint', async () => {
    const first = (await owner.goals.create({ slug: 'dup-slug', name: 'First' })) as {
      goal: { id: number };
    };
    await expect(
      owner.goals.create({ slug: 'dup-slug', name: 'Second' })
    ).rejects.toThrow(/duplicate|unique|already/i);
    await owner.goals.delete({ goal_id: first.goal.id });
  });

  it('links a watcher to a goal, nulls goal_id on goal delete, and rejects cross-org goal_id', async () => {
    const goal = (await owner.goals.create({ slug: 'link-test', name: 'Linker' })) as {
      goal: { id: number };
    };

    // Create-time link
    const created = (await owner.watchers.create({
      slug: 'goal-linked-watcher',
      name: 'Goal Linked Watcher',
      prompt: 'Track items.',
      extraction_schema: { type: 'object', properties: {} },
      agent_id: agentId,
      goal_id: goal.goal.id,
    })) as { watcher_id: string };

    const got = (await owner.watchers.get(created.watcher_id)) as {
      watcher?: { goal_id: number | null };
    };
    expect(got.watcher?.goal_id).toBe(goal.goal.id);

    // Update-time unlink
    await owner.watchers.update({ watcher_id: created.watcher_id, goal_id: null });
    const afterUnlink = (await owner.watchers.get(created.watcher_id)) as {
      watcher?: { goal_id: number | null };
    };
    expect(afterUnlink.watcher?.goal_id).toBeNull();

    // Re-link, then delete the goal — watcher.goal_id must become NULL
    // (ON DELETE SET NULL), not delete the watcher.
    await owner.watchers.update({ watcher_id: created.watcher_id, goal_id: goal.goal.id });
    await owner.goals.delete({ goal_id: goal.goal.id });

    const afterGoalDelete = (await owner.watchers.get(created.watcher_id)) as {
      watcher?: { goal_id: number | null };
    };
    expect(afterGoalDelete.watcher?.goal_id).toBeNull();

    // Cross-org goal_id is rejected (the FK would accept any goal id; the
    // handler validates org scope).
    const otherGoal = (await intruder.goals.create({
      slug: 'other-org-goal',
      name: 'Other Goal',
    })) as { goal: { id: number } };

    await expect(
      owner.watchers.update({
        watcher_id: created.watcher_id,
        goal_id: otherGoal.goal.id,
      })
    ).rejects.toThrow(/not found in this organization/i);

    await owner.watchers.delete([created.watcher_id]);
    await intruder.goals.delete({ goal_id: otherGoal.goal.id });
  });

  it('cascades the goal away when its organization is deleted', async () => {
    const tmpOrg = await createTestOrganization({ name: 'Goals Tmp Org' });
    const tmpUser = await createTestUser({ email: 'goals-tmp@test.com' });
    await addUserToOrganization(tmpUser.id, tmpOrg.id, 'owner');
    const tmpClient = await TestApiClient.for({
      organizationId: tmpOrg.id,
      userId: tmpUser.id,
      memberRole: 'owner',
    });

    const tmpGoal = (await tmpClient.goals.create({
      slug: 'tmp-goal',
      name: 'Will be cascaded',
    })) as { goal: { id: number } };

    const sql = getTestDb();
    // Drop the org row directly (better-auth Org deletes go through HTTP — we
    // just want to assert the FK cascade landed).
    await sql.unsafe(`DELETE FROM "organization" WHERE id = $1`, [tmpOrg.id]);

    const remaining = (await sql.unsafe(
      `SELECT id FROM goals WHERE id = $1`,
      [tmpGoal.goal.id]
    )) as Array<{ id: number }>;
    expect(remaining.length).toBe(0);
  });

  it('exposes manage_goals on the REST tool surface (smoke check)', async () => {
    // Sanity: the namespaces below are wired in client-sdk + REST. This just
    // confirms that the SDK + handler are mounted under client.goals.
    expect(typeof owner.goals.create).toBe('function');
    expect(typeof owner.goals.list).toBe('function');
    expect(organizationId).toBeTruthy();
    expect(intruderOrgId).toBeTruthy();
  });
});
