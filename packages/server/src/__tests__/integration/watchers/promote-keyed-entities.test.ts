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
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
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

/**
 * Per-record shape owned by the `topic` entity type's `metadata_schema`.
 * The watcher's extraction contract is DERIVED from this (an array of these
 * records at `keying_config.entity_path`), never authored on the watcher.
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

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

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
    allowInternalTools: true,
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

  const watcher = (await workspace.owner.watchers.create({
    entity_id: parentEntity.id,
    slug: 'keyed-watcher',
    name: 'Keyed Watcher',
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

  it('syncs extracted fields into entities and respects a human-owned field on re-run, queuing an approval', async () => {
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

    // Run 1: a non-key `severity` field is synced into the promoted entity's metadata.
    await ctx.api.watchers.completeWindow({
      watcher_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    const appCrashesId = `${watcherId}::stability::app-crashes`;
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
    const [edited] = await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    // Slice 1: human edit applies the value AND marks the field owned, carrying the note.
    expect((edited.metadata as Record<string, unknown>).severity).toBe('high');
    const sevControl = (edited.field_controls as Record<string, { note?: string; set_by?: string }>)
      .severity;
    expect(sevControl).toBeTruthy();
    expect(sevControl.note).toBe('confirmed critical with eng');
    expect(sevControl.set_by).toBe(workspace.users.owner.id);

    // Run 2 (replay) proposes a different severity for the SAME key.
    await ctx.api.watchers.completeWindow({
      watcher_id: String(watcherId),
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
    const proposal = pending[0].action_input as { entity_id: number; fields: Record<string, unknown> };
    expect(proposal.entity_id).toBe(entityId);
    expect(proposal.fields.severity).toBe('critical');

    // Idempotency: replaying the SAME window again must NOT stack a second
    // pending approval card (complete_window is replay-safe under retries/replicas).
    await ctx.api.watchers.completeWindow({
      watcher_id: String(watcherId),
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

    const [applied] = await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    // Still owned — an approved watcher value remains human-owned, not watcher-writable.
    expect((applied.field_controls as Record<string, unknown>).severity).toBeTruthy();
    const [approvedRun] = await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending[0].id)}`;
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
    await ctx.api.watchers.completeWindow({
      watcher_id: String(watcherId),
      window_token: token,
      run_metadata: { watcher_run_id: runId },
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const appCrashesId = `${watcherId}::stability::app-crashes`;
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'watcher_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);
    await workspace.owner.entities.update({ entity_id: entityId, metadata: { severity: 'high' } });

    // Run 2: watcher proposes 'critical' against the 'high' snapshot → pending approval.
    await ctx.api.watchers.completeWindow({
      watcher_id: String(watcherId),
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
    expect((pending.action_input as { current?: Record<string, unknown> }).current?.severity).toBe('high');

    // The human moves severity to 'medium' AFTER the proposal was queued (proposal is now stale).
    await workspace.owner.entities.update({ entity_id: entityId, metadata: { severity: 'medium' } });

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
    const [resolved] = await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending.id)}`;
    expect(resolved.status).toBe('completed');
    expect(resolved.approval_status).toBe('approved');
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
