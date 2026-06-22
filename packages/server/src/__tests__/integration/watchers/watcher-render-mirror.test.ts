/**
 * Watcher render lives in the unified view_template_versions store, keyed by the watcher
 * GROUP (resource_type='watcher', resource_id=group-root id, org from the root watcher).
 * As of phase 3b the WRITE path (handleCreate + create_version) populates it directly
 * (the phase-1 mirror trigger is retired); versions with no template (AutoRenderer) are
 * skipped. The re-parent re-key now lives in the app (entity deletion) — see the
 * entity-deletion test below.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { manageWatchers } from '../../../tools/admin/manage_watchers';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const sql = getTestDb();

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
  } as ToolContext;
}

async function makeWatcher(
  workspace: TestWorkspace,
  suffix: string,
  jsonTemplate: unknown | null
): Promise<number> {
  const entity = await createTestEntity({
    name: `Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const w = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: `w-${suffix}`,
    name: `W ${suffix}`,
    prompt: 'Summarize {{entities}}.',
    extraction_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    schedule: '0 9 * * *',
    agent_id: agent.agentId,
    ...(jsonTemplate ? { json_template: jsonTemplate } : {}),
  })) as { watcher_id: string };
  return Number(w.watcher_id);
}

async function mirrored(watcherId: number) {
  return (await sql`
    SELECT resource_id, organization_id, version, tab_name, json_template
    FROM view_template_versions
    WHERE resource_type = 'watcher' AND resource_id = ${String(watcherId)}
    ORDER BY version
  `) as Array<{
    resource_id: string;
    organization_id: string;
    version: number;
    tab_name: string | null;
    json_template: unknown;
  }>;
}

describe('watcher render mirrors into view_template_versions (phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('mirrors a watcher render, keyed by group id + the root org, tab_name NULL', async () => {
    const ws = await TestWorkspace.create({ name: 'Mirror Org' });
    const tmpl = { version: 1, root: { type: 'text', content: 'hello' } };
    const wid = await makeWatcher(ws, 'tmpl', tmpl);

    const rows = await mirrored(wid);
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(String(wid));
    expect(rows[0].organization_id).toBe(ws.org.id);
    expect(Number(rows[0].version)).toBe(1);
    expect(rows[0].tab_name).toBeNull();
    expect(rows[0].json_template).toEqual(tmpl);
  });

  it('skips a watcher version with no json_template (AutoRenderer)', async () => {
    const ws = await TestWorkspace.create({ name: 'NoTmpl Org' });
    const wid = await makeWatcher(ws, 'notmpl', null);
    expect(await mirrored(wid)).toHaveLength(0);
  });

  it('mirrors a new version on create_version (v2)', async () => {
    const ws = await TestWorkspace.create({ name: 'Versioned Org' });
    const wid = await makeWatcher(ws, 'ver', { version: 1, root: { type: 'text', content: 'v1' } });

    const v2 = { version: 1, root: { type: 'text', content: 'v2' } };
    await manageWatchers(
      {
        action: 'create_version',
        watcher_id: String(wid),
        json_template: v2,
      } as never,
      {} as Env,
      ownerCtx(ws)
    );

    const rows = await mirrored(wid);
    expect(rows.map((r) => Number(r.version))).toEqual([1, 2]);
    expect(rows[1].json_template).toEqual(v2);
  });

  it('re-parenting (group-root entity force-delete) re-keys the render to the surviving sibling', async () => {
    const ws = await TestWorkspace.create({ name: 'Reparent Org' });
    const entityA = await createTestEntity({
      name: 'A',
      organization_id: ws.org.id,
      created_by: ws.users.owner.id,
    });
    const entityB = await createTestEntity({
      name: 'B',
      organization_id: ws.org.id,
      created_by: ws.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: ws.org.id,
      ownerUserId: ws.users.owner.id,
    });
    const tmpl = { version: 1, root: { type: 'text', content: 'rp' } };
    const root = (await ws.owner.watchers.create({
      entity_id: entityA.id,
      slug: 'rp-root',
      name: 'RP',
      prompt: 'p',
      extraction_schema: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'] },
      schedule: '0 9 * * *',
      agent_id: agent.agentId,
      json_template: tmpl,
    })) as { watcher_id: string };
    const rootId = Number(root.watcher_id);

    // Assign the version chain to entity B (create_from_version → shares the group).
    const cur = (await sql`
      SELECT current_version_id FROM watchers WHERE id = ${rootId}
    `) as Array<{ current_version_id: number }>;
    const assign = (await manageWatchers(
      {
        action: 'create_from_version',
        version_id: String(cur[0].current_version_id),
        entity_ids: [entityB.id],
      } as never,
      {} as Env,
      ownerCtx(ws)
    )) as { created: Array<{ watcher_id: string }> };
    const assignId = Number(assign.created[0].watcher_id);
    expect(await mirrored(rootId)).toHaveLength(1);

    // Force-delete entity A (the root watcher's entity): entity-management re-parents the
    // shared chain to the surviving B assignment, and the app re-keys the render with it.
    await ws.owner.entities.delete(entityA.id, { force_delete_tree: true });

    expect(await mirrored(rootId)).toHaveLength(0); // old root key cleared
    const moved = await mirrored(assignId);
    expect(moved).toHaveLength(1); // re-keyed to the surviving sibling (new group root)
    expect(moved[0].json_template).toEqual(tmpl);
  });
});
