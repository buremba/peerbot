/**
 * Integration test: a watcher derives its window RENDER from its target entity
 * type's view template (consolidation — "render lives on the entity type", the
 * sibling of the extraction-schema derivation). When a watcher names
 * keying_config.entity_type and supplies NO inline json_template, get_watchers
 * serves the entity type's per-record render as `entity_type_render` plus the
 * record-array path as `entity_render_path` — so the client renders each window
 * record with the SAME template the entity detail page uses.
 *
 * Proves:
 *   1. deriveWatcherRender resolves a real entity type's render (and the path).
 *   2. It returns null when the type has no render / the watcher isn't entity-typed.
 *   3. get_watchers serves entity_type_render only when the watcher carries no
 *      inline json_template (own render wins).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { WatcherMetadata } from '../../../types/watchers';
import { deriveWatcherRender } from '../../../utils/watcher-render';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const TOPIC_METADATA_SCHEMA = {
  type: 'object',
  properties: { category: { type: 'string' }, name: { type: 'string' } },
  required: ['category', 'name'],
  additionalProperties: true,
};

// The entity type's per-record render (a JsonTemplate root node — the same shape
// view_template_versions.json_template stores and the entity detail page renders).
const TOPIC_RENDER = {
  type: 'card',
  children: [{ type: 'card-title', props: { children: '{{name}}' } }],
};

const KEYING_CONFIG = {
  entity_path: 'problems',
  key_fields: ['category', 'name'],
  key_output_field: 'problem_key',
  entity_type: 'topic',
};

async function setupWorkspace(opts: { withRender: boolean }) {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Render-From-Entity Org' });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  // 'topic' type. entity_types' unique index is partial (WHERE deleted_at IS
  // NULL) so ON CONFLICT can't bind — check then insert.
  const existing = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${workspace.org.id} AND slug = 'topic' AND deleted_at IS NULL
    LIMIT 1
  `;
  let topicId: number;
  if (existing.length > 0) {
    topicId = Number(existing[0].id);
    await sql`UPDATE entity_types SET metadata_schema = ${sql.json(TOPIC_METADATA_SCHEMA)} WHERE id = ${topicId}`;
  } else {
    const ins = await sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_METADATA_SCHEMA)}, current_timestamp, current_timestamp)
      RETURNING id
    `;
    topicId = Number(ins[0].id);
  }

  if (opts.withRender) {
    // Set the topic type's default render: a view_template_versions row pointed to
    // by entity_types.current_view_template_version_id (the resolution my helper
    // follows).
    const v = await sql`
      INSERT INTO view_template_versions
        (resource_type, resource_id, organization_id, version, tab_name, tab_order, json_template, created_by, created_at)
      VALUES
        ('entity_type', 'topic', ${workspace.org.id}, 1, NULL, 0, ${sql.json(TOPIC_RENDER)}, ${ownerUserId}, current_timestamp)
      RETURNING id
    `;
    await sql`UPDATE entity_types SET current_view_template_version_id = ${Number(v[0].id)} WHERE id = ${topicId}`;
  }

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'render-agent',
    name: 'Render Agent',
  });

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });

  return { sql, dbClient, workspace, api, parentEntityId: parentEntity.id, agent };
}

describe('deriveWatcherRender', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('resolves a real entity type render + the record-array path', async () => {
    const ctx = await setupWorkspace({ withRender: true });
    const derived = await deriveWatcherRender(ctx.dbClient, ctx.workspace.org.id, KEYING_CONFIG);
    expect(derived).not.toBeNull();
    expect(derived?.render).toEqual(TOPIC_RENDER);
    expect(derived?.entityPath).toBe('problems');
  });

  it('returns null when the entity type carries no render', async () => {
    const ctx = await setupWorkspace({ withRender: false });
    const derived = await deriveWatcherRender(ctx.dbClient, ctx.workspace.org.id, KEYING_CONFIG);
    expect(derived).toBeNull();
  });

  it('returns null when the watcher is not entity-typed', async () => {
    const ctx = await setupWorkspace({ withRender: true });
    const noType = { ...KEYING_CONFIG, entity_type: undefined };
    const derived = await deriveWatcherRender(ctx.dbClient, ctx.workspace.org.id, noType);
    expect(derived).toBeNull();
  });
});

describe('get_watchers serves the derived render', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('serves entity_type_render + entity_render_path for an entity-typed watcher with no inline json_template', async () => {
    const ctx = await setupWorkspace({ withRender: true });
    const created = (await ctx.workspace.owner.watchers.create({
      entity_id: ctx.parentEntityId,
      slug: 'render-watcher',
      name: 'Render Watcher',
      prompt: 'Extract problems for {{entities}}.',
      keying_config: KEYING_CONFIG,
      schedule: '0 9 * * *',
      agent_id: ctx.agent.agentId,
    })) as { watcher_id: string };

    const got = (await ctx.workspace.owner.watchers.get(created.watcher_id)) as {
      watcher?: WatcherMetadata;
    };
    expect(got.watcher?.json_template).toBeUndefined();
    expect(got.watcher?.entity_type_render).toEqual(TOPIC_RENDER);
    expect(got.watcher?.entity_render_path).toBe('problems');
  });

  it('does NOT derive a render when the watcher has its own json_template (own render wins)', async () => {
    const ctx = await setupWorkspace({ withRender: true });
    const ownTemplate = { type: 'card', children: [{ type: 'text', content: 'own' }] };
    const created = (await ctx.workspace.owner.watchers.create({
      entity_id: ctx.parentEntityId,
      slug: 'own-render-watcher',
      name: 'Own Render Watcher',
      prompt: 'Extract problems for {{entities}}.',
      keying_config: KEYING_CONFIG,
      json_template: ownTemplate,
      schedule: '0 9 * * *',
      agent_id: ctx.agent.agentId,
    })) as { watcher_id: string };

    const got = (await ctx.workspace.owner.watchers.get(created.watcher_id)) as {
      watcher?: WatcherMetadata;
    };
    expect(got.watcher?.json_template).toEqual(ownTemplate);
    expect(got.watcher?.entity_type_render).toBeUndefined();
  });
});
