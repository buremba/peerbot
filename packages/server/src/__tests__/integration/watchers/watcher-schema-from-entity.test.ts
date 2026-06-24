/**
 * Integration test: a watcher derives its extraction schema from its target
 * entity type's metadata_schema (consolidation — "schema lives on the entity
 * type"). When a watcher names keying_config.entity_type, complete_window
 * validates the extracted data against the entity type's schema — the SAME
 * schema that validates manual entity writes, so
 * a record's shape is defined exactly once.
 *
 * Proves:
 *   1. wrapMetadataSchemaAtPath builds the array-of-records output contract
 *      (single + nested entity_path).
 *   2. deriveWatcherExtractionSchema resolves a real entity type's schema.
 *   3. complete_window REJECTS extracted data that violates the entity type's
 *      schema and ACCEPTS data that conforms — with no inline watcher schema.
 */

import { inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { createWatcherRun } from '../../../runs/queue-service';
import { deriveWatcherExtractionSchema, wrapMetadataSchemaAtPath } from '../../../utils/watcher-extraction-schema';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const TOPIC_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['category', 'name'],
  additionalProperties: true,
};

const KEYING_CONFIG = {
  entity_path: 'problems',
  key_fields: ['category', 'name'],
  key_output_field: 'problem_key',
  entity_type: 'topic',
};

describe('wrapMetadataSchemaAtPath', () => {
  it('wraps a per-record schema as an array at a single-segment path', () => {
    const wrapped = wrapMetadataSchemaAtPath(TOPIC_METADATA_SCHEMA, 'problems') as Record<string, any>;
    expect(wrapped.type).toBe('object');
    expect(wrapped.required).toEqual(['problems']);
    expect(wrapped.properties.problems.type).toBe('array');
    expect(wrapped.properties.problems.items).toEqual(TOPIC_METADATA_SCHEMA);
  });

  it('nests required objects for a dotted path', () => {
    const wrapped = wrapMetadataSchemaAtPath(TOPIC_METADATA_SCHEMA, 'analysis.results.problems') as Record<
      string,
      any
    >;
    expect(wrapped.required).toEqual(['analysis']);
    expect(wrapped.properties.analysis.properties.results.properties.problems.type).toBe('array');
    expect(wrapped.properties.analysis.properties.results.properties.problems.items).toEqual(
      TOPIC_METADATA_SCHEMA
    );
  });
});

async function setupEntityTypedWatcher() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Schema-From-Entity Org' });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  // The 'topic' type carries the metadata_schema that becomes the watcher's
  // extraction contract. entity_types' unique index is partial (WHERE deleted_at
  // IS NULL), so ON CONFLICT can't bind — check then insert/update.
  const existingType = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${workspace.org.id} AND slug = 'topic' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existingType.length > 0) {
    await sql`
      UPDATE entity_types SET metadata_schema = ${sql.json(TOPIC_METADATA_SCHEMA)}
      WHERE id = ${existingType[0].id}
    `;
  } else {
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_METADATA_SCHEMA)}, current_timestamp, current_timestamp)
    `;
  }

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'schema-agent',
    name: 'Schema Agent',
  });

  // NB: no inline watcher schema — the watcher relies on the entity type's schema.
  const watcher = (await workspace.owner.watchers.create({
    entity_id: parentEntity.id,
    slug: 'schema-watcher',
    name: 'Schema Watcher',
    prompt: 'Extract problems for {{entities}}.',
    keying_config: KEYING_CONFIG,
    schedule: '0 9 * * *',
    agent_id: agent.agentId,
  })) as { watcher_id: string };
  const watcherId = Number(watcher.watcher_id);

  await sql`UPDATE watchers SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${watcherId}`;

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });

  return { sql, dbClient, workspace, api, parentEntityId: parentEntity.id, agent, watcherId };
}

type Ctx = Awaited<ReturnType<typeof setupEntityTypedWatcher>>;

async function queueRunningRun(ctx: Ctx) {
  const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
  const { windowStart, windowEnd } = await computePendingWindow(ctx.dbClient, ctx.watcherId, granularity);
  const queued = await createWatcherRun({
    organizationId: ctx.workspace.org.id,
    watcherId: ctx.watcherId,
    agentId: ctx.agent.agentId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dispatchSource: 'scheduled',
  });
  await ctx.sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${ctx.agent.agentId}`}
    WHERE id = ${queued.runId}
  `;
  return queued.runId;
}

async function readWindowToken(ctx: Ctx): Promise<string> {
  const content = (await ctx.api.knowledge.read({ watcher_id: ctx.watcherId })) as { window_token: string };
  return content.window_token;
}

describe('complete_window derives its schema from the entity type', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('resolves a real entity type metadata_schema into an extraction schema', async () => {
    const ctx = await setupEntityTypedWatcher();
    const derived = (await deriveWatcherExtractionSchema(
      ctx.dbClient,
      ctx.workspace.org.id,
      KEYING_CONFIG
    )) as Record<string, any>;
    expect(derived).not.toBeNull();
    expect(derived.properties.problems.items.required).toEqual(['category', 'name']);
  });

  it('REJECTS extracted data missing a field the entity type requires', async () => {
    const ctx = await setupEntityTypedWatcher();
    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: ctx.workspace.org.id,
      content: 'Users report problems.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    // 'name' is required by topic's metadata_schema but missing here.
    await expect(
      ctx.api.watchers.completeWindow({
        watcher_id: String(ctx.watcherId),
        window_token: token,
        extracted_data: { problems: [{ category: 'Stability' }] },
        run_metadata: { watcher_run_id: runId },
      })
    ).rejects.toThrow(/does not match|name/i);
  });

  it('ACCEPTS extracted data that conforms to the entity type schema (no inline schema)', async () => {
    const ctx = await setupEntityTypedWatcher();
    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: ctx.workspace.org.id,
      content: 'Users report problems.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    const completion = (await ctx.api.watchers.completeWindow({
      watcher_id: String(ctx.watcherId),
      window_token: token,
      extracted_data: { problems: [{ category: 'Stability', name: 'App Crashes' }] },
      run_metadata: { watcher_run_id: runId },
    })) as { action: string };
    expect(completion.action).toBe('complete_window');

    // And the conforming record promoted into a topic entity under the parent.
    const promoted = await ctx.sql`
      SELECT e.name FROM entities e
      JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.organization_id = ${ctx.workspace.org.id} AND ei.namespace = 'watcher_key'
    `;
    expect(promoted.length).toBe(1);
  });
});
