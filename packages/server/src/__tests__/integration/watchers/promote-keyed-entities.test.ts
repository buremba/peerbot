/**
 * Integration test for P2 phase 1: promoting keyed watcher-window rows into
 * real child entities.
 *
 * complete_window computes stable keys (keying_config) and then promotes each
 * keyed row into a child entity under the watcher's bound parent, keyed by an
 * entity_identities `watcher_key` claim (the idempotency lock). Origin
 * provenance (window_id / stable_key / watcher_id) is stamped onto the child
 * entity's own metadata — there is no separate observation event.
 *
 * Proves:
 *   1. Completing a window with keyed rows creates the expected child entities
 *      (resolvable by stable key), each carrying its origin window in metadata.
 *   2. Re-running the SAME window (run-driven idempotent replay, same window_id)
 *      creates NO duplicate entities.
 */

import { inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { slugify } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { createWatcherRun } from '../../../runs/queue-service';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const KEYING_CONFIG = {
  entity_path: 'problems',
  key_fields: ['category', 'name'],
  key_output_field: 'problem_key',
  entity_type: 'topic',
};

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          name: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
  required: ['problems'],
};

const KEYED_EXTRACTED_DATA = {
  problems: [
    { category: 'Stability', name: 'App Crashes' },
    { category: 'Performance', name: 'Slow Loading' },
  ],
};

async function setupKeyedWatcher() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Keyed Promotion Org' });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  // Promotion resolves the target type itself; ensure `topic` exists in the org.
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${workspace.org.id}, 'topic', 'Topic', current_timestamp, current_timestamp)
    ON CONFLICT DO NOTHING
  `;

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'keyed-agent',
    name: 'Keyed Agent',
  });

  const watcher = (await workspace.owner.watchers.create({
    entity_id: parentEntity.id,
    slug: 'keyed-watcher',
    name: 'Keyed Watcher',
    prompt: 'Extract problems for {{entities}}.',
    extraction_schema: EXTRACTION_SCHEMA,
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

  return {
    sql,
    dbClient,
    workspace,
    api,
    parentEntityId: parentEntity.id,
    agent,
    watcherId,
  };
}

/**
 * Queue + claim a running watcher run for the watcher's pending window so a
 * completion lands on the run-driven path (which makes the SAME window
 * reusable for an idempotent replay).
 */
async function queueRunningRun(ctx: Awaited<ReturnType<typeof setupKeyedWatcher>>) {
  const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
  const { windowStart, windowEnd } = await computePendingWindow(
    ctx.dbClient,
    ctx.watcherId,
    granularity
  );
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

/** A read_knowledge window token to complete against (reused for replays). */
async function readWindowToken(
  ctx: Awaited<ReturnType<typeof setupKeyedWatcher>>
): Promise<string> {
  const content = (await ctx.api.knowledge.read({ watcher_id: ctx.watcherId })) as {
    window_token: string;
  };
  return content.window_token;
}

async function completeWithToken(
  ctx: Awaited<ReturnType<typeof setupKeyedWatcher>>,
  windowToken: string,
  runId: number
): Promise<number> {
  const completion = (await ctx.api.watchers.completeWindow({
    watcher_id: String(ctx.watcherId),
    window_token: windowToken,
    extracted_data: KEYED_EXTRACTED_DATA,
    run_metadata: { watcher_run_id: runId },
  })) as { action: string; window_id: number };
  expect(completion.action).toBe('complete_window');
  return completion.window_id;
}

describe('complete_window promotes keyed rows into entities (P2 phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates a child entity per keyed row, with origin window provenance in its metadata', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    const windowId = await completeWithToken(ctx, token, runId);

    // Two child entities, one per stable key, hung under the parent.
    const identities = await sql`
      SELECT ei.identifier, ei.entity_id, e.name, e.parent_id
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'watcher_key'
      ORDER BY ei.identifier
    `;
    expect(identities.map((r) => String(r.identifier))).toEqual([
      `${watcherId}::performance::slow-loading`,
      `${watcherId}::stability::app-crashes`,
    ]);
    for (const row of identities) {
      expect(Number(row.parent_id)).toBe(parentEntityId);
    }

    // The promoted entities are of the configured type.
    const childTypes = await sql`
      SELECT et.slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.parent_id = ${parentEntityId}
        AND e.organization_id = ${workspace.org.id}
    `;
    expect(childTypes).toHaveLength(2);
    expect(childTypes.every((r) => String(r.slug) === 'topic')).toBe(true);

    // Origin provenance lives on the entity itself — each promoted child carries
    // its window_id / stable_key in metadata (no separate observation event).
    const childMeta = await sql`
      SELECT e.metadata
      FROM entities e
      JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'watcher_key'
      ORDER BY ei.identifier
    `;
    expect(childMeta).toHaveLength(2);
    const stableKeys = childMeta.map((r) => (r.metadata as Record<string, unknown>).stable_key);
    expect(stableKeys.sort()).toEqual(['performance::slow-loading', 'stability::app-crashes']);
    for (const row of childMeta) {
      const md = row.metadata as Record<string, unknown>;
      expect(Number(md.window_id)).toBe(windowId);
      expect(Number(md.watcher_id)).toBe(watcherId);
    }
  });

  it('is idempotent across a same-window replay — no duplicate entities', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    // Reuse the SAME window token for both completions so the replay targets the
    // exact same window (run-driven reuse keeps the window_id stable).
    const token = await readWindowToken(ctx);
    const firstWindowId = await completeWithToken(ctx, token, runId);

    const entitiesAfterFirst = await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${workspace.org.id} AND namespace = 'watcher_key'
      ORDER BY entity_id
    `;
    expect(entitiesAfterFirst).toHaveLength(2);

    // Re-run the SAME window (run-driven idempotent replay reuses the same
    // window_id) — the agent retried the completion.
    const secondWindowId = await completeWithToken(ctx, token, runId);
    expect(secondWindowId).toBe(firstWindowId);

    const entitiesAfterSecond = await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${workspace.org.id} AND namespace = 'watcher_key'
      ORDER BY entity_id
    `;
    // Same entities resolved — NO duplicates.
    expect(entitiesAfterSecond.map((r) => Number(r.entity_id)).sort()).toEqual(
      entitiesAfterFirst.map((r) => Number(r.entity_id)).sort()
    );
    expect(entitiesAfterSecond).toHaveLength(2);

    // No entity-count growth under the parent.
    const childCount = await sql`
      SELECT COUNT(*)::int AS c FROM entities
      WHERE parent_id = ${parentEntityId} AND organization_id = ${workspace.org.id}
    `;
    expect(Number(childCount[0].c)).toBe(2);
  });

  it('disambiguates a slug that collides with a pre-existing sibling — window is NOT poison-pilled', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Pre-create a sibling under the parent whose slug is EXACTLY the one the
    // first keyed row ("Stability · App Crashes") slugifies to. Without
    // collision-tolerant insertion, promotion's INSERT throws 23505 and rolls
    // the whole window completion back — permanently, since the slug is
    // deterministic (every retry re-hits it). This is the poison-pill.
    const collidingSlug = slugify('Stability · App Crashes');
    const [topicType] = (await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'topic'
      LIMIT 1
    `) as Array<{ id: number }>;
    await sql`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, parent_id, created_by,
        created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${topicType.id}, 'Squatter', ${collidingSlug},
        ${parentEntityId}, ${workspace.users.owner.id}, current_timestamp, current_timestamp
      )
    `;

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    // MUST NOT throw — the window completes despite the slug collision.
    const windowId = await completeWithToken(ctx, token, runId);

    // Both keyed rows promoted: two watcher_key identities exist.
    const identities = await sql`
      SELECT ei.identifier, ei.entity_id, e.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'watcher_key'
      ORDER BY ei.identifier
    `;
    expect(identities).toHaveLength(2);

    // The "App Crashes" promotion got a DISAMBIGUATED slug (not the squatter's).
    const appCrashes = identities.find((r) =>
      String(r.identifier).endsWith('::stability::app-crashes')
    );
    expect(appCrashes).toBeDefined();
    expect(String(appCrashes?.slug)).not.toBe(collidingSlug);
    expect(String(appCrashes?.slug).startsWith(`${collidingSlug}-`)).toBe(true);

    // The squatter is untouched; the promoted entity carries its origin window.
    const promoted = await sql`SELECT metadata FROM entities WHERE id = ${appCrashes?.entity_id}`;
    expect(Number((promoted[0].metadata as Record<string, unknown>).window_id)).toBe(windowId);
  });
});
