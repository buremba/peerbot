/**
 * Integration test for P2 phase 1: promoting keyed watcher-window rows into
 * real child entities + append-only observation events.
 *
 * complete_window computes stable keys (keying_config) and then promotes each
 * keyed row into:
 *   - a child entity under the watcher's bound parent, keyed by an
 *     entity_identities `watcher_key` claim (idempotency lock), and
 *   - an append-only `observation` event linking it to the window
 *     (metadata.window_id / stable_key / watcher_id).
 *
 * Proves:
 *   1. Completing a window with keyed rows creates the expected child entities
 *      (resolvable by stable key) and one observation event per child.
 *   2. Re-running the SAME window (run-driven idempotent replay, same window_id)
 *      creates NO duplicate entities and NO duplicate observation events.
 */

import { inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DbClient, parsePgNumberArray } from '../../../db/client';
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

  it('creates a child entity + observation event per keyed row', async () => {
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

    // One observation event per child, carrying window_id / stable_key.
    const observations = await sql`
      SELECT entity_ids, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'observation'
      ORDER BY metadata->>'stable_key'
    `;
    expect(observations).toHaveLength(2);
    const keys = observations.map((o) => (o.metadata as Record<string, unknown>).stable_key);
    expect(keys.sort()).toEqual(['performance::slow-loading', 'stability::app-crashes']);
    for (const obs of observations) {
      const md = obs.metadata as Record<string, unknown>;
      expect(Number(md.window_id)).toBe(windowId);
      expect(Number(md.watcher_id)).toBe(watcherId);
      // entity_ids is bigint[] → comes back as the literal "{N}" under
      // fetch_types:false; parse before asserting it points at one child.
      const eids = parsePgNumberArray(obs.entity_ids);
      expect(eids).toHaveLength(1);
    }
  });

  it('is idempotent across a same-window replay — no duplicate entities or observations', async () => {
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
    const obsAfterFirst = await sql`
      SELECT id FROM events
      WHERE organization_id = ${workspace.org.id} AND semantic_type = 'observation'
    `;
    expect(entitiesAfterFirst).toHaveLength(2);
    expect(obsAfterFirst).toHaveLength(2);

    // Re-run the SAME window (run-driven idempotent replay reuses the same
    // window_id) — the agent retried the completion.
    const secondWindowId = await completeWithToken(ctx, token, runId);
    expect(secondWindowId).toBe(firstWindowId);

    const entitiesAfterSecond = await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${workspace.org.id} AND namespace = 'watcher_key'
      ORDER BY entity_id
    `;
    const obsAfterSecond = await sql`
      SELECT id, metadata FROM events
      WHERE organization_id = ${workspace.org.id} AND semantic_type = 'observation'
    `;

    // Same entities resolved — NO duplicates.
    expect(entitiesAfterSecond.map((r) => Number(r.entity_id)).sort()).toEqual(
      entitiesAfterFirst.map((r) => Number(r.entity_id)).sort()
    );
    expect(entitiesAfterSecond).toHaveLength(2);

    // Still exactly two observation events — NO duplicates (same window_id +
    // stable_key resolves the existing observation).
    expect(obsAfterSecond).toHaveLength(2);
    const keysSecond = obsAfterSecond.map(
      (o) => (o.metadata as Record<string, unknown>).stable_key as string
    );
    expect(new Set(keysSecond)).toEqual(
      new Set(['stability::app-crashes', 'performance::slow-loading'])
    );

    // No entity-count growth under the parent.
    const childCount = await sql`
      SELECT COUNT(*)::int AS c FROM entities
      WHERE parent_id = ${parentEntityId} AND organization_id = ${workspace.org.id}
    `;
    expect(Number(childCount[0].c)).toBe(2);
  });

  it('dedups a concurrent re-insert of the same observation via ON CONFLICT (N>1 race guard)', async () => {
    // The sequential replay above is caught by the check-then-insert SELECT; this
    // exercises the ON CONFLICT path that backs TRUE concurrency — two replicas
    // completing the same window where neither's SELECT sees the other's uncommitted
    // insert. The partial unique index must make the second a no-op, not a duplicate.
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    await completeWithToken(ctx, token, runId);

    const [obs] = (await sql`
      SELECT origin_id, entity_ids, created_by, metadata FROM events
      WHERE organization_id = ${workspace.org.id} AND semantic_type = 'observation'
      ORDER BY metadata->>'stable_key' LIMIT 1
    `) as Array<{
      origin_id: string;
      entity_ids: string;
      created_by: string;
      metadata: Record<string, unknown>;
    }>;

    // The racer: same (org, origin_id), the exact ON CONFLICT clause the producer uses.
    const racer = await sql`
      INSERT INTO events (entity_ids, organization_id, origin_id, semantic_type, metadata, created_by, created_at)
      VALUES (${String(obs.entity_ids)}::bigint[], ${workspace.org.id}, ${String(obs.origin_id)}, 'observation', ${sql.json(obs.metadata)}, ${obs.created_by}, NOW())
      ON CONFLICT (organization_id, origin_id)
        WHERE semantic_type = 'observation' AND metadata ->> 'category' = 'watcher_promotion'
        DO NOTHING
      RETURNING id
    `;
    expect(racer).toHaveLength(0); // deduped by idx_events_watcher_promotion_observation_unique

    const dupes = (await sql`
      SELECT COUNT(*)::int AS n FROM events WHERE origin_id = ${String(obs.origin_id)}
    `) as Array<{ n: number }>;
    expect(dupes[0].n).toBe(1); // still exactly one — no duplicate observation
  });
});
