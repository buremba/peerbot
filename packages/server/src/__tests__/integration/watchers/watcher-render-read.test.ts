/**
 * Watcher-render consolidation phase 2: the display readers (get_watchers,
 * window-utils windows query, manage_watchers list) read the render from
 * view_template_versions (the phase-1 mirror) instead of watcher_versions.json_template.
 * Multi-replica-safe: the mirror trigger keeps both in sync, so old pods (read
 * watcher_versions) and new pods (read the mirror) return the same render.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const sql = getTestDb();

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

function renderOf(got: unknown): unknown {
  const g = got as { watcher?: { json_template?: unknown }; json_template?: unknown };
  return g.watcher?.json_template ?? g.json_template;
}

describe('watcher render reads from view_template_versions (phase 2)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  // Edit the mirror row to a sentinel (watcher_versions keeps the original) to prove
  // a reader is reading FROM the mirror, not from watcher_versions.json_template.
  async function pokeMirror(watcherId: number, value: object) {
    await sql`
      UPDATE view_template_versions SET json_template = ${sql.json(value)}
      WHERE resource_type = 'watcher' AND resource_id = ${String(watcherId)}
    `;
  }

  it('get() reads the render from the mirror, not watcher_versions', async () => {
    const ws = await TestWorkspace.create({ name: 'Read Org' });
    const tmpl = { version: 1, root: { type: 'text', content: 'rendered' } };
    const wid = await makeWatcher(ws, 'r', tmpl);

    // Baseline: the flipped get() finds the mirror row by (group, version, org).
    expect(renderOf(await ws.owner.watchers.get(wid))).toEqual(tmpl);

    // Prove the read is off the MIRROR: poke the mirror to a sentinel (the source
    // column still holds tmpl). get() must return the sentinel.
    const sentinel = { version: 1, root: { type: 'text', content: 'from-mirror' } };
    await pokeMirror(wid, sentinel);
    expect(renderOf(await ws.owner.watchers.get(wid))).toEqual(sentinel);
  });

  it('list() reads the current-version render from the mirror', async () => {
    const ws = await TestWorkspace.create({ name: 'List Org' });
    const tmpl = { version: 1, root: { type: 'text', content: 'listed' } };
    const wid = await makeWatcher(ws, 'l', tmpl);

    const sentinel = { version: 1, root: { type: 'text', content: 'list-from-mirror' } };
    await pokeMirror(wid, sentinel);

    const listed = (await ws.owner.watchers.list({ include_details: true })) as {
      watchers?: Array<{ watcher_id?: string | number; json_template?: unknown }>;
    };
    const arr = Array.isArray(listed) ? listed : (listed.watchers ?? []);
    const row = arr.find((w) => String(w.watcher_id) === String(wid));
    expect(row?.json_template).toEqual(sentinel);
  });

  it('get_version_details reads the render from the mirror', async () => {
    const ws = await TestWorkspace.create({ name: 'Detail Org' });
    const tmpl = { version: 1, root: { type: 'text', content: 'detail' } };
    const wid = await makeWatcher(ws, 'd', tmpl);

    const sentinel = { version: 1, root: { type: 'text', content: 'detail-from-mirror' } };
    await pokeMirror(wid, sentinel);

    const got = (await ws.owner.watchers.getVersionDetails({
      watcher_id: String(wid),
    })) as { json_template?: unknown };
    expect(got.json_template).toEqual(sentinel);
  });
});
