/**
 * Watcher-render consolidation phase 1: watcher_versions.json_template is mirrored
 * into the unified view_template_versions store by a DB trigger, keyed by the watcher
 * GROUP (resource_type='watcher', resource_id=watcher group-root id, org from the root
 * watcher). Versions with no json_template (AutoRenderer) are skipped. No is_current —
 * the watcher display reads a specific selected version. Reads flip in phase 2.
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

  it('clears the mirror when a version json_template is updated to NULL', async () => {
    const ws = await TestWorkspace.create({ name: 'ClearTmpl Org' });
    const wid = await makeWatcher(ws, 'clear', { version: 1, root: { type: 'text', content: 'x' } });
    expect(await mirrored(wid)).toHaveLength(1);
    // A templated -> NULL transition must drop the mirror row (not leave it stale),
    // so a reader off the mirror matches a reader off watcher_versions (now NULL).
    await sql`UPDATE watcher_versions SET json_template = NULL WHERE watcher_id = ${wid}`;
    expect(await mirrored(wid)).toHaveLength(0);
  });

  it('re-keys the mirror when a version chain is re-parented to a new root', async () => {
    const ws = await TestWorkspace.create({ name: 'Reparent Org' });
    const wid = await makeWatcher(ws, 'rp', { version: 1, root: { type: 'text', content: 'x' } });
    expect(await mirrored(wid)).toHaveLength(1);

    // A bare new-root watcher in the same org (no versions of its own), then
    // re-parent the chain — entity-management does this on group-root deletion
    // with surviving siblings (UPDATE watcher_versions SET watcher_id = new_root).
    const agent = await createTestAgent({
      organizationId: ws.org.id,
      ownerUserId: ws.users.owner.id,
    });
    const newRoot = wid + 7_000_000;
    await sql`
      INSERT INTO watchers (id, name, slug, organization_id, agent_id, created_by, watcher_group_id)
      VALUES (${newRoot}, 'new-root', ${`nr-${newRoot}`}, ${ws.org.id}, ${agent.agentId}, ${ws.users.owner.id}, ${newRoot})
    `;
    await sql`UPDATE watcher_versions SET watcher_id = ${newRoot} WHERE watcher_id = ${wid}`;

    expect(await mirrored(wid)).toHaveLength(0); // stale old key cleared
    const moved = await mirrored(newRoot);
    expect(moved).toHaveLength(1); // re-keyed under the new root
    expect(Number(moved[0].version)).toBe(1);
    expect(moved[0].organization_id).toBe(ws.org.id);
  });
});
