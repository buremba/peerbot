/**
 * Integration test for P2 phase 1: promoting keyed watcher-window rows into
 * real child entities.
 *
 * complete_window persists each declared entity output row under the watcher's
 * bound parent, keyed by an internal stable identity and an
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

import { inferBehaviorGranularityFromSchedule } from '@lobu/connector-sdk';
import { slugify } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { createWatcherRun } from '../../../runs/queue-service';
import { computePendingWindow } from '../../../utils/window-utils';
import { promoteBehaviorEntityOutput } from '../../../utils/promote-keyed-entities';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';
import {
  computeStableKey,
  formatBehaviorEntityIdentity,
} from '../../../utils/stable-keys';

const OUTPUTS = {
  problems: { entity: 'topic', key: ['category', 'name'] },
};

/**
 * Per-record shape owned by the `topic` entity type's `metadata_schema`.
 * The watcher's extraction contract is DERIVED from this (an array of these
 * records in `outputs.problems`), never authored on the Behavior.
 */
const TOPIC_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    name: { type: 'string' },
  },
  additionalProperties: true,
};

const KEYED_EXTRACTED_DATA = {
  problems: [
    { category: 'Stability', name: 'App Crashes' },
    { category: 'Performance', name: 'Slow Loading' },
  ],
};

const stableTopicKey = (category: string, name: string) =>
  computeStableKey({ category, name }, ['category', 'name']);
const APP_CRASHES_KEY = stableTopicKey('Stability', 'App Crashes');
const SLOW_LOADING_KEY = stableTopicKey('Performance', 'Slow Loading');
const topicIdentity = (watcherId: number, stableKey: string) =>
  formatBehaviorEntityIdentity(watcherId, 'problems', 'topic', stableKey);

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

/**
 * Block until some backend is waiting on a transaction lock — the state the
 * losing promotion's INSERT enters while the sibling slug it collides with is
 * still uncommitted. Polls on a THIRD connection so it observes A and B rather
 * than participating.
 *
 * Releasing A directly instead would be a coin flip, not a race: A usually
 * commits before B has even acquired its connection, so B's identity probe
 * finds the committed claim and returns down the ordinary idempotent path,
 * never reaching the lost-race cleanup this test exists to prove. Throws rather
 * than hanging, so a future version where the race stops being reachable fails
 * loudly instead of silently testing nothing.
 */
async function waitForBlockedEntityInsert(
  sql: ReturnType<typeof getTestDb>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO entities%'
    `;
    if (Number(rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'no entity INSERT blocked on the uncommitted sibling slug; the promotion race was not reached'
  );
}

/** Owner web-session auth context for invoking manage_operations.approve. */
function ownerAuthCtx(orgId: string, userId: string): AuthContext {
  return {
    organizationId: orgId,
    tokenOrganizationId: orgId,
    userId,
    memberRole: 'owner',
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    requestUrl: `http://localhost/api/${orgId}`,
    baseUrl: '',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

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

  // Promotion resolves the target type itself; ensure `topic` exists in the
  // org, and own the extraction contract on the type's `metadata_schema`.
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
    VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_RECORD_SCHEMA)}, current_timestamp, current_timestamp)
    ON CONFLICT DO NOTHING
  `;

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'keyed-agent',
    name: 'Keyed Agent',
  });

  const watcher = (await workspace.owner.behaviors.create({
    entity_id: parentEntity.id,
    slug: 'keyed-watcher',
    name: 'Keyed Watcher',
    prompt: 'Extract problems for {{entities}}.',
    outputs: OUTPUTS,
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { behavior_id: string };
  const watcherId = Number(watcher.behavior_id);

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
  const granularity = inferBehaviorGranularityFromSchedule('0 9 * * *');
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
  const content = (await ctx.api.knowledge.read({
    behavior_id: ctx.watcherId,
  })) as {
    window_token: string;
  };
  return content.window_token;
}

async function completeWithToken(
  ctx: Awaited<ReturnType<typeof setupKeyedWatcher>>,
  windowToken: string,
  runId: number,
  extractedData: Record<string, unknown> = KEYED_EXTRACTED_DATA
): Promise<number> {
  const completion = (await ctx.api.behaviors.completeWindow({
    behavior_id: String(ctx.watcherId),
    window_token: windowToken,
    extracted_data: extractedData,
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
    const { sql, workspace, parentEntityId } = ctx;

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
      topicIdentity(
        ctx.watcherId,
        computeStableKey(
          { category: 'Performance', name: 'Slow Loading' },
          ['category', 'name']
        )
      ),
      topicIdentity(
        ctx.watcherId,
        computeStableKey(
          { category: 'Stability', name: 'App Crashes' },
          ['category', 'name']
        )
      ),
    ].sort());
    for (const row of identities) {
      expect(Number(row.parent_id)).toBe(parentEntityId);
    }

    // The promoted entities are of the configured type. complete_window also
    // creates the per-watcher canvas entity as a child of the same parent
    // (canvas-on-events, metadata.source='watcher_canvas'), so scope the
    // promoted-type assertion to the non-canvas children.
    const childTypes = await sql`
      SELECT et.slug, e.metadata->>'source' AS source
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.parent_id = ${parentEntityId}
        AND e.organization_id = ${workspace.org.id}
    `;
    expect(childTypes).toHaveLength(3);
    const promoted = childTypes.filter((r) => r.source !== 'watcher_canvas');
    expect(promoted).toHaveLength(2);
    expect(promoted.every((r) => String(r.slug) === 'topic')).toBe(true);
    const canvasChildren = childTypes.filter((r) => r.source === 'watcher_canvas');
    expect(canvasChildren).toHaveLength(1);
    // The canvas entity must carry the built-in `$canvas` type. Without an
    // explicitly created `canvas` type, the old fallback commonly bound it to
    // `$member`, exposing it through the access-controlled member roster.
    expect(String(canvasChildren[0].slug)).toBe('$canvas');

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
    expect(stableKeys.sort()).toEqual([APP_CRASHES_KEY, SLOW_LOADING_KEY].sort());
    for (const row of childMeta) {
      const md = row.metadata as Record<string, unknown>;
      expect(Number(md.window_id)).toBe(windowId);
      expect(Number(md.watcher_id)).toBe(ctx.watcherId);
    }

    // The run carries a FIRST-CLASS change-set event listing what it applied —
    // even though these creates were auto-applied (no approval involved). This
    // is the run's own diff, not an approval artifact.
    const changeSet = await sql`
      SELECT title, metadata, entity_ids
      FROM current_event_records
      WHERE run_id = ${runId}
        AND organization_id = ${workspace.org.id}
        AND semantic_type = 'change_set'
    `;
    expect(changeSet).toHaveLength(1);
    const csMeta = changeSet[0].metadata as Record<string, unknown>;
    expect(csMeta.kind).toBe('watcher_change_set');
    expect(Number(csMeta.window_id)).toBe(windowId);
    expect(Number(csMeta.created_count)).toBe(2);
    expect(Number(csMeta.updated_count)).toBe(0);
    const csChanges = csMeta.changes as Array<{
      kind: string;
      entityId: number;
    }>;
    expect(csChanges).toHaveLength(2);
    expect(csChanges.every((c) => c.kind === 'created')).toBe(true);
  });

  it('rejects duplicate exact keys instead of silently dropping an output row', async () => {
    const ctx = await setupKeyedWatcher();
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    await expect(
      ctx.api.behaviors.completeWindow({
        behavior_id: String(ctx.watcherId),
        window_token: token,
        run_metadata: { watcher_run_id: runId },
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', severity: 'high' },
            { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          ],
        },
      })
    ).rejects.toThrow(/duplicate.*key/i);

    const identities = await ctx.sql<{ count: number }>`
      SELECT COUNT(*)::int AS count
      FROM entity_identities
      WHERE organization_id = ${ctx.workspace.org.id}
        AND namespace = 'watcher_key'
    `;
    expect(Number(identities[0].count)).toBe(0);
  });

  it('does not reuse an old-type entity when a later version retargets the output', async () => {
    const ctx = await setupKeyedWatcher();
    await ctx.sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (
        ${ctx.workspace.org.id},
        'issue',
        'Issue',
        ${ctx.sql.json(TOPIC_RECORD_SCHEMA)},
        current_timestamp,
        current_timestamp
      )
    `;
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    const extracted = {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'high' }],
    };
    await completeWithToken(ctx, token, runId, extracted);

    await ctx.api.behaviors.createVersion({
      behavior_id: String(ctx.watcherId),
      outputs: { problems: { entity: 'issue', key: ['category', 'name'] } },
    });
    const retargetedRunId = await queueRunningRun(ctx);
    const retargetedToken = await readWindowToken(ctx);
    await completeWithToken(ctx, retargetedToken, retargetedRunId, extracted);

    const promotedTypes = await ctx.sql<{ slug: string }>`
      SELECT et.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE ei.organization_id = ${ctx.workspace.org.id}
        AND ei.namespace = 'watcher_key'
        AND ei.deleted_at IS NULL
      ORDER BY et.slug
    `;
    expect(promotedTypes.map((row) => row.slug)).toEqual(['issue', 'topic']);
  });

  it('keeps an exact in-window source_event_id and drops ungranted claims', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, parentEntityId } = ctx;

    // Place the in-window event inside the behavior's pending daily window so
    // read_knowledge actually grants it in the token's content_ids.
    const granularity = inferBehaviorGranularityFromSchedule('0 9 * * *');
    const { windowStart } = await computePendingWindow(
      ctx.dbClient,
      ctx.watcherId,
      granularity
    );
    const inWindow = await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(windowStart.getTime() + 60 * 60 * 1000),
    });
    // Content that exists in the org but is NOT part of this window's token.
    const outOfWindow = await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Unrelated content the agent must not be able to cite.',
      occurred_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    await completeWithToken(ctx, token, runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', source_event_id: Number(inWindow.id) },
        {
          category: 'Performance',
          name: 'Slow Loading',
          source_event_id: Number(outOfWindow.id),
        },
        {
          category: 'Stability',
          name: 'Fractional Reference',
          source_event_id: Number(inWindow.id) + 0.5,
        },
        {
          category: 'Stability',
          name: 'String Reference',
          source_event_id: String(inWindow.id),
        },
      ],
    });

    const rows = await sql`
      SELECT ei.identifier, e.metadata->>'source_event_id' AS source_event_id
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'watcher_key'
      ORDER BY ei.identifier
    `;
    const byIdentifier = Object.fromEntries(
      rows.map((r) => [String(r.identifier), r.source_event_id])
    );

    // The verifiable claim survives; unverifiable values are stripped rather
    // than stored as false provenance. Every row still promotes.
    expect(byIdentifier[topicIdentity(ctx.watcherId, APP_CRASHES_KEY)]).toBe(
      String(inWindow.id)
    );
    expect(
      byIdentifier[
        topicIdentity(
          ctx.watcherId,
          stableTopicKey('Stability', 'Fractional Reference')
        )
      ]
    ).toBeNull();
    expect(byIdentifier[topicIdentity(ctx.watcherId, SLOW_LOADING_KEY)]).toBeNull();
    expect(
      byIdentifier[
        topicIdentity(ctx.watcherId, stableTopicKey('Stability', 'String Reference'))
      ]
    ).toBeNull();
    expect(Object.keys(byIdentifier)).toHaveLength(4);
  });

  it("a create=deny policy on the watcher's OWNING AGENT blocks its promotions", async () => {
    // The v1.1 fix: a watcher is its agent's autonomous mode, so the agent's own
    // envelope binds the watcher. Pin entity create=deny to THIS watcher's agent;
    // the promotion must create nothing. Before the fix the gate resolved the
    // watcher as principal `watcher:<id>` (agentId null), so this agent-scoped
    // deny never matched and the rows were created under the looser org default.
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId, parentEntityId, agent } = ctx;

    const policyRows = await sql<{ id: number }>`
      INSERT INTO write_approval_policies
        (organization_id, resource_class, principal_kind, principal_id)
      VALUES (${workspace.org.id}, 'entity', 'agent', ${agent.agentId})
      RETURNING id
    `;
    await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${Number(policyRows[0].id)}, 'create', 'deny')
    `;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    await completeWithToken(ctx, token, runId);

    // No `topic` entities were promoted — the agent's deny bound the watcher.
    const promoted = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c
      FROM entity_identities
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'watcher_key'
        AND identifier LIKE ${`${watcherId}::%`}
    `;
    expect(Number(promoted[0].c)).toBe(0);
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

    // No entity-count growth under the parent: 2 promoted + exactly 1 canvas
    // entity. The replay must reuse the canvas identity claim (namespace
    // 'watcher_canvas'), never mint a second canvas entity.
    const childCount = await sql`
      SELECT COUNT(*)::int AS c FROM entities
      WHERE parent_id = ${parentEntityId} AND organization_id = ${workspace.org.id}
    `;
    expect(Number(childCount[0].c)).toBe(3);
    const canvasCount = await sql`
      SELECT COUNT(*)::int AS c FROM entities
      WHERE parent_id = ${parentEntityId}
        AND organization_id = ${workspace.org.id}
        AND metadata->>'source' = 'watcher_canvas'
    `;
    expect(Number(canvasCount[0].c)).toBe(1);

    const changeSets = await sql`
      SELECT id, metadata->>'_lobu_idempotency_key' AS idempotency_key
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND run_id = ${runId}
        AND semantic_type = 'change_set'
    `;
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0].idempotency_key).toBe(
      `behavior:${watcherId}:run:${runId}:change_set`
    );
  });

  it('hard-deletes the provisional entity after losing a concurrent identity race', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId, parentEntityId } = ctx;
    const promote = (tx: DbClient, windowId: number) =>
      promoteBehaviorEntityOutput({
        tx,
        extractedData: {
          problems: [{ category: 'Stability', name: 'App Crashes' }],
        },
        outputName: 'problems',
        output: OUTPUTS.problems,
        watcherId,
        organizationId: workspace.org.id,
        windowId,
        parentEntityId,
        createdBy: workspace.users.owner.id,
        validContentIds: new Set<number>(),
      });

    let signalAReady!: () => void;
    const aReady = new Promise<void>((resolve) => {
      signalAReady = resolve;
    });
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A promotes (entity insert + identity claim) and parks with its
    // transaction still OPEN, so neither row is visible to B yet.
    const runA = sql.begin(async (tx) => {
      const result = await promote(tx as unknown as DbClient, 1001);
      signalAReady();
      await aMayCommit;
      return result;
    });
    await aReady;

    // B must NOT be awaited before A is released: B's entity insert blocks on
    // A's uncommitted sibling slug, so awaiting here deadlocks the test against
    // itself instead of exercising the race.
    const runB = sql.begin((tx) => promote(tx as unknown as DbClient, 1002));
    try {
      await waitForBlockedEntityInsert(sql);
    } finally {
      releaseA();
    }
    const [a, b] = await Promise.all([runA, runB]);

    expect(a.created).toBe(1);
    expect(b.created).toBe(0);
    const identity = topicIdentity(watcherId, APP_CRASHES_KEY);
    const rows = await sql`
      SELECT e.id, e.slug
      FROM entities e
      WHERE e.organization_id = ${workspace.org.id}
        AND e.parent_id = ${parentEntityId}
        AND e.metadata->>'stable_key' = ${APP_CRASHES_KEY}
    `;
    expect(rows).toHaveLength(1);
    const claims = await sql`
      SELECT entity_id
      FROM entity_identities
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'watcher_key'
        AND identifier = ${identity}
        AND deleted_at IS NULL
    `;
    expect(claims).toHaveLength(1);
    expect(Number(claims[0].entity_id)).toBe(Number(rows[0].id));
  });

  it('syncs extracted fields into entities and respects a human-owned field on re-run, queuing an approval', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    // Run 1: a non-key `severity` field is synced into the promoted entity's metadata.
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(ctx.watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    const appCrashesId = topicIdentity(ctx.watcherId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id, e.metadata, e.field_controls
      FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'watcher_key' AND ei.identifier = ${appCrashesId}
    `;
    // Slice 2 (create): the extracted field value lands in metadata, not just provenance.
    expect((created.metadata as Record<string, unknown>).severity).toBe('low');
    expect(created.field_controls).toEqual({});
    const entityId = Number(created.id);

    // A human takes ownership of `severity`, attaching a correction note.
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
      field_note: 'confirmed critical with eng',
    });
    const [edited] =
      await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    // Slice 1: human edit applies the value AND marks the field owned, carrying the note.
    expect((edited.metadata as Record<string, unknown>).severity).toBe('high');
    const sevControl = (edited.field_controls as Record<string, { note?: string; set_by?: string }>)
      .severity;
    expect(sevControl).toBeTruthy();
    expect(sevControl.note).toBe('confirmed critical with eng');
    expect(sevControl.set_by).toBe(workspace.users.owner.id);

    // Run 2 (replay) proposes a different severity for the SAME key.
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(ctx.watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    // Slice 2 (match): the watcher does NOT overwrite the human-owned value.
    const [afterRerun] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((afterRerun.metadata as Record<string, unknown>).severity).toBe('high');

    // Slice 3: the blocked change is queued as a durable approval the human can act on.
    const pendingRuns = async () => sql`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    const pending = await pendingRuns();
    expect(pending.length).toBe(1);
    const proposal = pending[0].action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(proposal.entity_id).toBe(entityId);
    expect(proposal.fields.severity).toBe('critical');

    // Idempotency: replaying the SAME window again must NOT stack a second
    // pending approval card (complete_window is replay-safe under retries/replicas).
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(ctx.watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    expect((await pendingRuns()).length).toBe(1);

    // Slice 3 (apply): an owner approves via manage_operations → the value lands and
    // the field stays human-owned (now carrying the approved value).
    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending[0].id) },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { approved?: boolean };
    expect(approveRes.approved).toBe(true);

    const [applied] =
      await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    // Still owned — an approved watcher value remains human-owned, not watcher-writable.
    expect((applied.field_controls as Record<string, unknown>).severity).toBeTruthy();
    const [approvedRun] =
      await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending[0].id)}`;
    expect(approvedRun.status).toBe('completed');
    expect(approvedRun.approval_status).toBe('approved');
  });

  it('approving a STALE proposal does not clobber a value the human moved after it was queued', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    // Run 1 seeds the entity; human then owns `severity` at 'high'.
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const appCrashesId = topicIdentity(watcherId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'watcher_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
    });

    // Run 2: watcher proposes 'critical' against the 'high' snapshot → pending approval.
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const [pending] = await sql`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${workspace.org.id} AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect((pending.action_input as { current?: Record<string, unknown> }).current?.severity).toBe(
      'high'
    );

    // The human moves severity to 'medium' AFTER the proposal was queued (proposal is now stale).
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'medium' },
    });

    // Approving the stale proposal must NOT overwrite the human's newer 'medium'.
    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending.id) },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { approved?: boolean; message?: string };
    expect(approveRes.approved).toBe(true);

    const [after] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((after.metadata as Record<string, unknown>).severity).toBe('medium'); // human wins
    // Run still resolves (terminal), it just applied nothing.
    const [resolved] =
      await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending.id)}`;
    expect(resolved.status).toBe('completed');
    expect(resolved.approval_status).toBe('approved');
  });

  it('list_promoted returns the watcher promoted entities with field ownership + provenance', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    const windowId = await ctx.api.behaviors.completeWindow({
      behavior_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    // A human owns `severity` on one of the two promoted entities.
    const appCrashesId = topicIdentity(watcherId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'watcher_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
      field_note: 'confirmed critical with eng',
    });

    const res = (await workspace.owner.behaviors.manage({
      action: 'list_promoted',
      behavior_id: String(watcherId),
    })) as {
      action: string;
      entities: Array<{
        id: number;
        name: string;
        entity_type: string;
        metadata: Record<string, unknown>;
        field_controls: Record<string, { set_by?: string; note?: string }>;
        window_id: number | null;
        stable_key: string | null;
      }>;
    };

    expect(res.action).toBe('list_promoted');
    expect(res.entities.length).toBe(2);
    const appCrashes = res.entities.find((e) => e.stable_key === APP_CRASHES_KEY);
    const slowLoading = res.entities.find((e) => e.stable_key === SLOW_LOADING_KEY);
    expect(appCrashes).toBeDefined();
    expect(slowLoading).toBeDefined();

    // The owned entity carries its human ownership marker + the corrected value…
    expect(appCrashes?.id).toBe(entityId);
    expect(appCrashes?.entity_type).toBe('topic');
    expect(appCrashes?.metadata.severity).toBe('high');
    expect(appCrashes?.field_controls.severity?.set_by).toBe(workspace.users.owner.id);
    expect(appCrashes?.window_id).toBe((windowId as { window_id: number }).window_id);
    // …while the untouched entity has no owned fields.
    expect(slowLoading?.field_controls).toEqual({});
  });

  it('approve (affirm_fields) locks a value as-is so a later watcher change is blocked', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    // Run 1 seeds `severity: 'low'` (watcher-owned, no field_controls yet).
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const appCrashesId = topicIdentity(watcherId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'watcher_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);

    // The human APPROVES the current value as-is (no value change) — the recap's
    // "approve" affordance. This must claim ownership (not the pre-fix no-op).
    await workspace.owner.entities.update({
      entity_id: entityId,
      affirm_fields: ['severity'],
      field_note: 'looks right',
    });
    const [afterApprove] = await sql`
      SELECT metadata, field_controls FROM entities WHERE id = ${entityId}
    `;
    expect((afterApprove.metadata as Record<string, unknown>).severity).toBe('low'); // unchanged
    const sevControl = (
      afterApprove.field_controls as Record<string, { set_by?: string; note?: string }>
    ).severity;
    expect(sevControl?.set_by).toBe(workspace.users.owner.id); // now human-owned
    expect(sevControl?.note).toBe('looks right');

    // Run 2 proposes a different severity for the SAME key. Because the human
    // affirmed the field, the watcher must be BLOCKED and queue an approval —
    // proving the affirm actually locked the value.
    await ctx.api.behaviors.completeWindow({
      behavior_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    const [afterRerun] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((afterRerun.metadata as Record<string, unknown>).severity).toBe('low'); // affirm held

    const pending = await sql`
      SELECT action_input FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending.length).toBe(1);
    const proposal = pending[0].action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(proposal.entity_id).toBe(entityId);
    expect(proposal.fields.severity).toBe('critical');
  });

  it('disambiguates a slug that collides with a pre-existing sibling — window is NOT poison-pilled', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, parentEntityId, watcherId } = ctx;

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

    // The "App Crashes" promotion took the FIRST readable suffix, not the
    // squatter's slug and not the identifier fallback.
    const appCrashes = identities.find(
      (r) => String(r.identifier) === topicIdentity(watcherId, APP_CRASHES_KEY)
    );
    expect(appCrashes).toBeDefined();
    expect(String(appCrashes?.slug)).toBe(`${collidingSlug}-2`);

    // The promoted entity carries its origin window.
    const promoted = await sql`SELECT metadata FROM entities WHERE id = ${appCrashes?.entity_id}`;
    expect(Number((promoted[0].metadata as Record<string, unknown>).window_id)).toBe(windowId);
  });

  it('uses the identifier fallback after every readable slug suffix collides', async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, parentEntityId, watcherId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Occupy the base slug and all four readable suffixes. Promotion must reach
    // the final identifier-derived fallback without poison-pilling the window.
    const collidingSlug = slugify('Stability · App Crashes');
    const [topicType] = (await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'topic'
      LIMIT 1
    `) as Array<{ id: number }>;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const occupiedSlug = attempt === 1 ? collidingSlug : `${collidingSlug}-${attempt}`;
      await sql`
        INSERT INTO entities (
          organization_id, entity_type_id, name, slug, parent_id, created_by,
          created_at, updated_at
        ) VALUES (
          ${workspace.org.id}, ${topicType.id}, ${`Squatter ${attempt}`}, ${occupiedSlug},
          ${parentEntityId}, ${workspace.users.owner.id}, current_timestamp, current_timestamp
        )
      `;
    }

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

    // The "App Crashes" promotion exhausted the readable suffixes and used its
    // identity-derived fallback.
    const appCrashes = identities.find(
      (r) => String(r.identifier) === topicIdentity(watcherId, APP_CRASHES_KEY)
    );
    expect(appCrashes).toBeDefined();
    expect(String(appCrashes?.slug)).toBe(
      `${collidingSlug}-${slugify(topicIdentity(watcherId, APP_CRASHES_KEY))}`
    );

    // The promoted entity carries its origin window.
    const promoted = await sql`SELECT metadata FROM entities WHERE id = ${appCrashes?.entity_id}`;
    expect(Number((promoted[0].metadata as Record<string, unknown>).window_id)).toBe(windowId);
  });

  it("groups a run's proposals by window and approves them all in one batch", async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace, watcherId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);

    // Run 1: create both entities with a `severity` field.
    const windowId = await completeWithToken(ctx, token, runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', severity: 'low' },
        { category: 'Performance', name: 'Slow Loading', severity: 'low' },
      ],
    });

    // A human takes ownership of `severity` on BOTH promoted entities.
    const ids = await sql`
      SELECT ei.identifier, ei.entity_id FROM entity_identities ei
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'watcher_key'
      ORDER BY ei.identifier
    `;
    for (const row of ids) {
      await workspace.owner.entities.update({
        entity_id: Number(row.entity_id),
        metadata: { severity: 'high' },
        field_note: 'human-owned',
      });
    }

    // Run 2 (same window): the watcher proposes a new severity for BOTH — each is
    // blocked (human-owned) and queues its own pending proposal, sharing window_id.
    await completeWithToken(ctx, token, runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', severity: 'critical' },
        { category: 'Performance', name: 'Slow Loading', severity: 'critical' },
      ],
    });

    const pending = await sql`
      SELECT id, window_id FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal' AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
      ORDER BY id ASC
    `;
    expect(pending.length).toBe(2);
    // Both proposals carry the run's window_id on the COLUMN (batch grouping key).
    expect(pending.every((r) => Number(r.window_id) === windowId)).toBe(true);

    // A UI-pinned batch fails closed if another proposal appeared after review.
    const pendingIds = pending.map((row) => Number(row.id));
    const staleBatch = (await executeTool(
      'manage_operations',
      {
        action: 'approve_batch',
        window_id: windowId,
        run_ids: [pendingIds[0]],
      },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { error?: string };
    expect(staleBatch.error).toContain('Pending proposals changed');

    // approve_batch approves exactly the reviewed pending set in one call.
    const batchRes = (await executeTool(
      'manage_operations',
      { action: 'approve_batch', window_id: windowId, run_ids: pendingIds },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { action: string; approved_count?: number; failed_count?: number };
    expect(batchRes.action).toBe('approve_batch');
    expect(batchRes.approved_count).toBe(2);
    expect(batchRes.failed_count).toBe(0);

    // Both proposals applied and their runs completed.
    for (const row of ids) {
      const [applied] =
        await sql`SELECT metadata FROM entities WHERE id = ${Number(row.entity_id)}`;
      expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    }
    const stillPending = await sql`
      SELECT id FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal' AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(stillPending.length).toBe(0);
  });

  it("reject_batch cancels a run's proposals and records the reason for revision", async () => {
    const ctx = await setupKeyedWatcher();
    const { sql, workspace } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx);
    const windowId = await completeWithToken(ctx, token, runId, {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'low' }],
    });
    const [row] = await sql`
      SELECT ei.entity_id FROM entity_identities ei
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'watcher_key' LIMIT 1
    `;
    await workspace.owner.entities.update({
      entity_id: Number(row.entity_id),
      metadata: { severity: 'high' },
      field_note: 'human-owned',
    });
    await completeWithToken(ctx, token, runId, {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'critical' }],
    });

    const rejectRes = (await executeTool(
      'manage_operations',
      {
        action: 'reject_batch',
        window_id: windowId,
        reason: 'severity should stay high',
      },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { action: string; rejected_count?: number };
    expect(rejectRes.action).toBe('reject_batch');
    expect(rejectRes.rejected_count).toBe(1);

    // The human-owned value is untouched; the proposal run is cancelled.
    const [after] = await sql`SELECT metadata FROM entities WHERE id = ${Number(row.entity_id)}`;
    expect((after.metadata as Record<string, unknown>).severity).toBe('high');

    // The rejection reason is recorded as a `correction` feedback event — the
    // SAME channel getRecentFeedbackSummary reads to feed the watcher's next run
    // (the revision loop). Keyed to the watcher, field_path='$batch_reject'.
    const feedback = await sql`
      SELECT metadata FROM current_event_records
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'correction'
        AND (metadata->>'kind') = 'watcher_batch_reject'
    `;
    expect(feedback.length).toBe(1);
    expect((feedback[0].metadata as Record<string, unknown>).reason).toBe(
      'severity should stay high'
    );
  });
});
