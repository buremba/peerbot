/**
 * Integration test for the manual-trigger endpoint:
 *   POST /api/workers/me/watchers/:watcher_id/trigger
 *
 * Verifies:
 *   - Correctly-bound device → 200, pending run row created with manual
 *     dispatch_source.
 *   - Wrong device → 403, no run row created.
 *   - Re-trigger while a run is active → 200 `already_queued: true`, no
 *     second run row created.
 *   - Trigger does NOT advance `watchers.next_run_at`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { generateSecureToken, hashToken } from '../../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestWorkspace } from '../../setup/test-mcp-client';

/**
 * Mint a PAT bound to a specific device worker_id with `device_worker:run`
 * scope — same shape as createWorkerBoundPat in the sibling automation
 * contract test.
 */
async function createWorkerBoundPat(
  userId: string,
  organizationId: string,
  workerId: string,
  scope = 'device_worker:run'
): Promise<{ token: string }> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12);
  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, ${scope}, ${workerId},
      NOW(), NOW()
    )
  `;
  return { token };
}

/**
 * Set up a device-pinned watcher owned by the workspace owner. Returns
 * everything the tests need to mint the right PAT + assert on the run row.
 */
async function setupDevicePinnedWatcher(opts: {
  workerId: string;
}): Promise<{
  sql: ReturnType<typeof getTestDb>;
  dbClient: DbClient;
  workspace: Awaited<ReturnType<typeof TestWorkspace.create>>;
  watcherId: number;
  deviceWorkerId: string;
  agentId: string;
}> {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Manual Trigger Org' });
  const ownerUserId = workspace.users.owner.id;

  // Pre-register a device worker so the trigger can resolve the bound id.
  const inserted = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
    VALUES (${ownerUserId}, ${opts.workerId}, 'macos', ${sql.json({})}, 'Mac Test', ${workspace.org.id})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const deviceWorkerId = String(inserted[0].id);

  const entity = await createTestEntity({
    name: 'Trigger Entity',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'trigger-agent',
    name: 'Trigger Agent',
  });
  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: 'trigger-watcher',
    name: 'Trigger Watcher',
    prompt: 'Summarize {{entities}}.',
    extraction_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    schedule: '0 9 * * *',
    agent_id: agent.agentId,
  })) as { watcher_id: string };
  const watcherId = Number(watcher.watcher_id);

  // Pin the watcher to the device. `WatcherCreateInput` doesn't expose
  // device_worker_id / agent_kind, so set them directly — matches how
  // automation-contract.test.ts pins watchers for the #802 dispatcher tests.
  await sql`
    UPDATE watchers
    SET device_worker_id = ${deviceWorkerId}::uuid,
        agent_kind = 'claude-code'
    WHERE id = ${watcherId}
  `;

  return { sql, dbClient, workspace, watcherId, deviceWorkerId, agentId: agent.agentId };
}

describe('POST /api/workers/me/watchers/:watcher_id/trigger', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('correctly-bound device → 200 + manual run row', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-trigger-ok' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-ok'
    );

    const response = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      run_id: number;
      status: string;
      already_queued: boolean;
    };
    expect(json.run_id).toBeGreaterThan(0);
    expect(json.status).toBe('pending');
    expect(json.already_queued).toBe(false);

    const runs = await ctx.sql`
      SELECT id, status, watcher_id, run_type, approved_input
      FROM runs
      WHERE watcher_id = ${ctx.watcherId}
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].run_type)).toBe('watcher');
    expect(String(runs[0].status)).toBe('pending');
    const approved = runs[0].approved_input as Record<string, unknown>;
    expect(approved.dispatch_source).toBe('manual');
    expect(approved.device_worker_id).toBe(ctx.deviceWorkerId);
    expect(approved.agent_kind).toBe('claude-code');
  });

  it('wrong device → 403, no run created', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-pinned' });
    const ownerUserId = ctx.workspace.users.owner.id;

    // Same user registers a second, unrelated device. Their token is bound
    // to that second worker_id and must NOT be able to trigger watcher A.
    await ctx.sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${ownerUserId}, 'mac-other', 'macos', ${ctx.sql.json({})}, 'Other Mac', ${ctx.workspace.org.id})
    `;
    const { token } = await createWorkerBoundPat(
      ownerUserId,
      ctx.workspace.org.id,
      'mac-other'
    );

    const response = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not pinned to this device/i);

    const runs = await ctx.sql`
      SELECT id FROM runs WHERE watcher_id = ${ctx.watcherId}
    `;
    expect(runs).toHaveLength(0);
  });

  it('re-trigger while a run is pending → 200 already_queued, no duplicate run', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-trigger-idem' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-idem'
    );

    const first = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { run_id: number; already_queued: boolean };
    expect(firstJson.already_queued).toBe(false);

    const second = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      run_id: number;
      status: string;
      already_queued: boolean;
    };
    expect(secondJson.already_queued).toBe(true);
    expect(secondJson.run_id).toBe(firstJson.run_id);

    const runs = await ctx.sql`
      SELECT id FROM runs WHERE watcher_id = ${ctx.watcherId}
    `;
    expect(runs).toHaveLength(1);
  });

  it('also returns already_queued for claimed/running existing runs', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-trigger-claimed' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-claimed'
    );

    const first = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { run_id: number };

    // Advance the run from pending → running (post-claim state). The trigger
    // helper should still see it as active and refuse to start a second run.
    await ctx.sql`
      UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = 'mac-trigger-claimed'
      WHERE id = ${firstJson.run_id}
    `;

    const second = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      run_id: number;
      already_queued: boolean;
    };
    expect(secondJson.already_queued).toBe(true);
    expect(secondJson.run_id).toBe(firstJson.run_id);

    const runs = await ctx.sql`
      SELECT id, status FROM runs WHERE watcher_id = ${ctx.watcherId}
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('running');
  });

  it('does NOT advance watchers.next_run_at', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-trigger-nra' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-trigger-nra'
    );

    const [before] = await ctx.sql`
      SELECT next_run_at FROM watchers WHERE id = ${ctx.watcherId}
    `;
    const beforeNextRun = before.next_run_at as Date | string | null;

    const response = await post(
      `/api/workers/me/watchers/${ctx.watcherId}/trigger`,
      { token }
    );
    expect(response.status).toBe(200);

    const [after] = await ctx.sql`
      SELECT next_run_at FROM watchers WHERE id = ${ctx.watcherId}
    `;
    const afterNextRun = after.next_run_at as Date | string | null;
    // Either both null (no schedule) or identical timestamps. Manual trigger
    // must NOT shift the cron schedule forward.
    if (beforeNextRun === null) {
      expect(afterNextRun).toBeNull();
    } else {
      const beforeMs = new Date(beforeNextRun).getTime();
      const afterMs = afterNextRun ? new Date(afterNextRun).getTime() : 0;
      expect(afterMs).toBe(beforeMs);
    }
  });

  it('returns 404 for an unknown watcher id', async () => {
    const ctx = await setupDevicePinnedWatcher({ workerId: 'mac-404' });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-404'
    );

    const response = await post('/api/workers/me/watchers/999999999/trigger', {
      token,
    });
    expect(response.status).toBe(404);
  });
});
