/**
 * Watcher-render consolidation phase 3a: the write path (handleCreate v1 +
 * create_version) now also writes the render DIRECTLY into view_template_versions
 * (alongside watcher_versions + the mirror trigger), so the trigger +
 * watcher_versions.json_template can be retired in phase 3b/4. Validated with the
 * mirror trigger DISABLED — the app alone must populate view_template_versions.
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
  jsonTemplate: unknown
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
    json_template: jsonTemplate as Record<string, unknown>,
  })) as { watcher_id: string };
  return Number(w.watcher_id);
}

async function rendered(watcherId: number) {
  return (await sql`
    SELECT version, json_template FROM view_template_versions
    WHERE resource_type = 'watcher' AND resource_id = ${String(watcherId)}
    ORDER BY version
  `) as Array<{ version: number; json_template: unknown }>;
}

describe('watcher render direct write (phase 3a)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('app is the sole writer of the render into view_template_versions (trigger retired)', async () => {
    // Phase 3b: the mirror trigger is dropped and json_template is no longer written to
    // watcher_versions, so writeWatcherRender (handleCreate + create_version) is the only
    // thing that can populate view_template_versions.
    const ws = await TestWorkspace.create({ name: 'Direct Org' });
    const tmpl = { version: 1, root: { type: 'text', content: 'direct' } };
    const wid = await makeWatcher(ws, 'direct', tmpl);

    const r1 = await rendered(wid);
    expect(r1).toHaveLength(1);
    expect(r1[0].json_template).toEqual(tmpl);

    // create_version direct-writes its render, and carries the prev render forward.
    const v2 = { version: 1, root: { type: 'text', content: 'direct-v2' } };
    await manageWatchers(
      { action: 'create_version', watcher_id: String(wid), json_template: v2 } as never,
      {} as Env,
      ownerCtx(ws)
    );
    const r2 = await rendered(wid);
    expect(r2.map((r) => Number(r.version))).toEqual([1, 2]);
    expect(r2[1].json_template).toEqual(v2);

    // Carry-forward: a create_version with NO json_template inherits the prev render
    // from view_template_versions (not from watcher_versions, which is now NULL).
    await manageWatchers(
      { action: 'create_version', watcher_id: String(wid), prompt: 'changed' } as never,
      {} as Env,
      ownerCtx(ws)
    );
    const r3 = await rendered(wid);
    expect(r3.map((r) => Number(r.version))).toEqual([1, 2, 3]);
    expect(r3[2].json_template).toEqual(v2);
  });
});
