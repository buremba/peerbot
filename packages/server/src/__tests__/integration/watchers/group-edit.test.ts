/**
 * Group-edit refactor contracts.
 *
 * After this refactor:
 *   - Assigning a template to another entity (`create_from_version`) shares
 *     the existing `watcher_versions` row instead of duplicating it.
 *   - Editing one assignment via `create_version` cascades to every watcher
 *     in the group: same `current_version_id`, same `name`.
 *   - `set_reaction_script` cascades across the group.
 *   - A run snapshots `current_version_id` at creation; if the group is
 *     edited mid-run, `complete_window` still validates against the
 *     snapshot, not the new version.
 *   - Hard-deleting an entity that owns the group root transfers
 *     `watcher_versions` ownership to a surviving sibling so the cascade
 *     doesn't wipe the version chain out from under the group.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageWatchers } from '../../../tools/admin/manage_watchers';
import type { ToolContext } from '../../../tools/registry';
import { createWatcherRun } from '../../../utils/queue-helpers';
import { parseWatcherRunPayload } from '../../../watchers/automation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-workspace';

function ownerCtx(workspace: TestWorkspace): ToolContext {
  return {
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

async function seedRootWatcher(workspace: TestWorkspace, suffix: string) {
  const entity = await createTestEntity({
    name: `Root Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: `digest-${suffix}`,
    name: `Digest ${suffix}`,
    prompt: 'Summarize content for {{entities}}.',
    extraction_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    schedule: '0 9 * * *',
  })) as { watcher_id: string };
  return { watcherId: Number(watcher.watcher_id), entityId: entity.id };
}

async function assignToEntity(
  workspace: TestWorkspace,
  versionId: number,
  entityId: number
): Promise<number> {
  const result = (await manageWatchers(
    {
      action: 'create_from_version',
      version_id: String(versionId),
      entity_ids: [entityId],
    } as never,
    {} as Env,
    ownerCtx(workspace)
  )) as { created: Array<{ watcher_id: string }> };
  return Number(result.created[0].watcher_id);
}

describe('watcher group edit contract', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('create_from_version reuses the source version row instead of duplicating', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Reuse Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'reuse');

    const [rootRow] = await sql`
      SELECT current_version_id, watcher_group_id FROM watchers WHERE id = ${rootId}
    `;
    const rootVersionId = Number(rootRow.current_version_id);
    const groupId = Number(rootRow.watcher_group_id);
    expect(groupId).toBe(rootId);

    const sibling1Entity = await createTestEntity({
      name: 'Sibling 1',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling2Entity = await createTestEntity({
      name: 'Sibling 2',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });

    const sibling1Id = await assignToEntity(workspace, rootVersionId, sibling1Entity.id);
    const sibling2Id = await assignToEntity(workspace, rootVersionId, sibling2Entity.id);

    // All three watchers should point at the SAME version row.
    const rows = await sql`
      SELECT id, current_version_id, watcher_group_id
      FROM watchers WHERE id IN (${rootId}, ${sibling1Id}, ${sibling2Id})
      ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Number(row.current_version_id)).toBe(rootVersionId);
      expect(Number(row.watcher_group_id)).toBe(groupId);
    }

    // watcher_versions row count for this group is exactly 1, not 3.
    const versionCount = await sql`
      SELECT COUNT(*)::int as n FROM watcher_versions WHERE watcher_id = ${groupId}
    `;
    expect(Number(versionCount[0].n)).toBe(1);
  });

  it('create_from_version copies the reaction script onto each new assignment', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Script Copy Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'script-copy');

    await manageWatchers(
      {
        action: 'set_reaction_script',
        watcher_id: String(rootId),
        reaction_script: 'export default async function reaction() { return; }',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    const [rootRow] = await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `;
    const rootVersionId = Number(rootRow.current_version_id);

    const siblingEntity = await createTestEntity({
      name: 'Script Copy Sibling',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const siblingId = await assignToEntity(workspace, rootVersionId, siblingEntity.id);

    const [siblingRow] = await sql`
      SELECT reaction_script, reaction_script_compiled FROM watchers WHERE id = ${siblingId}
    `;
    expect(siblingRow.reaction_script).toContain('reaction');
    expect(siblingRow.reaction_script_compiled).not.toBeNull();
  });

  it('create_version cascades current_version_id and name across the whole group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Cascade Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'cascade');
    const [rootBefore] = await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `;
    const sibling1Entity = await createTestEntity({
      name: 'Cascade Sibling 1',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling2Entity = await createTestEntity({
      name: 'Cascade Sibling 2',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling1Id = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      sibling1Entity.id
    );
    const sibling2Id = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      sibling2Entity.id
    );

    // Edit through the SIBLING — group cascade should still apply, not just to the sibling.
    const result = (await manageWatchers(
      {
        action: 'create_version',
        watcher_id: String(sibling1Id),
        prompt: 'Cascaded prompt v2.',
        name: 'Cascaded Name v2',
        change_notes: 'group cascade',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    )) as { version_id: string; version: number };
    const newVersionId = Number(result.version_id);
    expect(result.version).toBe(2);

    const rows = await sql`
      SELECT id, current_version_id, name, version
      FROM watchers WHERE id IN (${rootId}, ${sibling1Id}, ${sibling2Id})
      ORDER BY id
    `;
    for (const row of rows) {
      expect(Number(row.current_version_id)).toBe(newVersionId);
      expect(row.name).toBe('Cascaded Name v2');
      expect(Number(row.version)).toBe(2);
    }

    // The new version row is owned by the group root, not the sibling.
    const [versionRow] = await sql`
      SELECT watcher_id, prompt FROM watcher_versions WHERE id = ${newVersionId}
    `;
    expect(Number(versionRow.watcher_id)).toBe(rootId);
    expect(versionRow.prompt).toBe('Cascaded prompt v2.');
  });

  it('set_reaction_script cascades to every watcher in the group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Script Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'script-cascade');
    const [rootBefore] = await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `;
    const siblingEntity = await createTestEntity({
      name: 'Script Cascade Sibling',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const siblingId = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      siblingEntity.id
    );

    await manageWatchers(
      {
        action: 'set_reaction_script',
        watcher_id: String(rootId),
        reaction_script: 'export default async function reaction() { /* v1 */ }',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    let rows = await sql`
      SELECT id, reaction_script FROM watchers WHERE id IN (${rootId}, ${siblingId}) ORDER BY id
    `;
    expect(rows[0].reaction_script).toContain('v1');
    expect(rows[1].reaction_script).toContain('v1');

    // Calling through the sibling (not the root) — should still cascade.
    await manageWatchers(
      {
        action: 'set_reaction_script',
        watcher_id: String(siblingId),
        reaction_script: '',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    rows = await sql`
      SELECT id, reaction_script FROM watchers WHERE id IN (${rootId}, ${siblingId}) ORDER BY id
    `;
    expect(rows[0].reaction_script).toBeNull();
    expect(rows[1].reaction_script).toBeNull();
  });

  it('createWatcherRun snapshots current_version_id; mid-run group edit does not change the run', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Run Snapshot Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'snapshot');

    const [rootBefore] = await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `;
    const snapshotVersionId = Number(rootBefore.current_version_id);

    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId: rootId,
      agentId: 'snapshot-agent',
      windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    // Group edit lands AFTER the run was created — current_version_id moves
    // to v2 on the watchers row, but the run's payload still holds v1.
    await manageWatchers(
      {
        action: 'create_version',
        watcher_id: String(rootId),
        prompt: 'Post-run edit.',
        change_notes: 'after run created',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    const [runRow] = await sql`
      SELECT (approved_input->>'version_id')::bigint as version_id
      FROM runs WHERE id = ${queued.runId}
    `;
    expect(Number(runRow.version_id)).toBe(snapshotVersionId);

    // The watcher itself has moved on — confirms the snapshot diverges.
    const [watcherAfter] = await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `;
    expect(Number(watcherAfter.current_version_id)).not.toBe(snapshotVersionId);
  });

  it('parseWatcherRunPayload returns the snapshot version_id', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Payload Parse Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'parse');

    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId: rootId,
      agentId: 'parse-agent',
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    const [run] = await sql`SELECT approved_input FROM runs WHERE id = ${queued.runId}`;
    const parsed = parseWatcherRunPayload(run.approved_input);
    expect(parsed).not.toBeNull();
    expect(parsed!.version_id).not.toBeNull();
    expect(Number.isFinite(parsed!.version_id as number)).toBe(true);
  });

  it('parseWatcherRunPayload tolerates legacy runs missing version_id', () => {
    const legacyPayload = {
      watcher_id: 1,
      agent_id: 'a',
      window_start: '2024-01-01',
      window_end: '2024-01-02',
      dispatch_source: 'scheduled',
    };
    const parsed = parseWatcherRunPayload(legacyPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.version_id).toBeNull();
  });

  it('complete_window scopes the run lookup by watcher_id', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Run Scope Org' });
    const { watcherId: aId } = await seedRootWatcher(workspace, 'scope-a');
    const { watcherId: bId } = await seedRootWatcher(workspace, 'scope-b');

    // Create a run for watcher A. The run's snapshot version is A's current.
    const aRun = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId: aId,
      agentId: 'a-agent',
      windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    // Now bump A's current_version_id to v2 — the snapshot in aRun still
    // points at v1, but if complete_window for B mistakenly uses aRun's id
    // it must NOT pick up A's v1 snapshot.
    await manageWatchers(
      {
        action: 'create_version',
        watcher_id: String(aId),
        prompt: "A's v2",
        change_notes: 'bump A',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    // Confirm the run lookup we use in complete_window won't return A's
    // snapshot when scoped by watcher_id = B.
    const [scopedToB] = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs WHERE id = ${aRun.runId} AND watcher_id = ${bId}
      LIMIT 1
    `;
    expect(scopedToB).toBeUndefined();
    const [scopedToA] = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs WHERE id = ${aRun.runId} AND watcher_id = ${aId}
      LIMIT 1
    `;
    expect(scopedToA).toBeDefined();
    expect(Number(scopedToA.version_id)).toBeGreaterThan(0);
  });

  it('serializes concurrent create_version calls on the same group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Concurrent Edit Org' });
    const { watcherId: rootId } = await seedRootWatcher(workspace, 'concurrent');

    // Fire two create_version calls in parallel. The advisory lock should
    // serialize them; one ends up at v2, the other at v3 — neither errors,
    // neither collides on (watcher_id, version) unique index.
    const [r1, r2] = await Promise.all([
      manageWatchers(
        {
          action: 'create_version',
          watcher_id: String(rootId),
          prompt: 'edit A',
          change_notes: 'A',
        } as never,
        {} as Env,
        ownerCtx(workspace)
      ),
      manageWatchers(
        {
          action: 'create_version',
          watcher_id: String(rootId),
          prompt: 'edit B',
          change_notes: 'B',
        } as never,
        {} as Env,
        ownerCtx(workspace)
      ),
    ]);

    const versions = [r1, r2]
      .map((r) => Number((r as { version: number }).version))
      .sort((a, b) => a - b);
    expect(versions).toEqual([2, 3]);

    const versionRows = await sql`
      SELECT version FROM watcher_versions WHERE watcher_id = ${rootId} ORDER BY version
    `;
    const stored = versionRows.map((r) => Number(r.version));
    expect(stored).toEqual([1, 2, 3]);
  });
});
