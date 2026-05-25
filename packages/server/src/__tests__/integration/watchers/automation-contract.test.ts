/**
 * Compact watcher automation contracts retained from the deleted broad suite.
 *
 * These are high-value queue/lifecycle boundaries: scheduled watchers should
 * materialize only one active run, dispatcher reconciliation should close runs
 * that already produced a window, and complete_window provenance should close
 * a running queued run.
 */

import { inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { generateWindowToken } from '../../../utils/jwt';
import { createWatcherRun } from '../../../utils/queue-helpers';
import { computePendingWindow } from '../../../utils/window-utils';
import {
  dispatchPendingWatcherRuns,
  materializeDueWatcherRuns,
  reconcileWatcherRuns,
  runWatcherAutomationTick,
  sweepStaleWatcherRuns,
} from '../../../watchers/automation';
import { generateSecureToken, hashToken } from '../../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

/**
 * Mint a PAT bound to a specific device worker_id and `device_worker:run`
 * scope. Mirrors PersonalAccessTokenService.create but inlined so the test
 * can pre-set the binding without going through the route.
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

async function createAutomatedWatcher() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Watcher Automation Contract Org' });

  const entity = await createTestEntity({
    name: 'Automation Entity',
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: 'watcher-agent',
    name: 'Watcher Agent',
  });

  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: 'automation-watcher',
    name: 'Automation Watcher',
    prompt: 'Summarize content for {{entities}}.',
    extraction_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    schedule: '0 9 * * *',
    agent_id: agent.agentId,
  })) as { watcher_id: string };
  const watcherId = Number(watcher.watcher_id);

  await sql`
    UPDATE watchers
    SET next_run_at = NOW() - INTERVAL '10 minutes'
    WHERE id = ${watcherId}
  `;

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
  });

  return { sql, dbClient, workspace, api, entityId: entity.id, agent, watcherId };
}

describe('watcher automation contract', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('materializes one scheduled watcher run and dedupes concurrent ticks', async () => {
    const { sql, watcherId, agent, workspace } = await createAutomatedWatcher();

    const [resultA, resultB] = await Promise.all([
      materializeDueWatcherRuns({} as Env),
      materializeDueWatcherRuns({} as Env),
    ]);

    expect(resultA.runsCreated + resultB.runsCreated).toBe(1);

    const runs = await sql`
      SELECT status, approved_input
      FROM runs
      WHERE watcher_id = ${watcherId}
        AND run_type = 'watcher'
        AND organization_id = ${workspace.org.id}
    `;
    expect(runs).toHaveLength(1);
    expect(String(runs[0].status)).toBe('pending');

    const payload = runs[0].approved_input as Record<string, unknown>;
    expect(Number(payload.watcher_id)).toBe(watcherId);
    expect(payload.agent_id).toBe(agent.agentId);
    expect(payload.dispatch_source).toBe('scheduled');
  });

  it('reconciles a queued watcher run when a correlated window already exists', async () => {
    const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();

    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(dbClient, watcherId, granularity);
    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    const [window] = await sql`
      INSERT INTO watcher_windows (
        watcher_id, granularity, window_start, window_end,
        extracted_data, content_analyzed, model_used, run_metadata, run_id, created_at
      ) VALUES (
        ${watcherId}, 'daily', ${windowStart}, ${windowEnd},
        ${sql.json({ summary: 'External completion' })}, 1, 'external-client',
        ${sql.json({ source: 'external', watcher_run_id: queued.runId })}, ${queued.runId}, NOW()
      )
      RETURNING id
    `;

    const result = await dispatchPendingWatcherRuns({} as Env, {
      db: dbClient,
      runIds: [queued.runId],
    });
    const [run] = await sql`
      SELECT status, window_id
      FROM runs
      WHERE id = ${queued.runId}
    `;

    expect(result.reconciled).toBe(1);
    expect(String(run.status)).toBe('completed');
    expect(Number(run.window_id)).toBe(Number(window.id));
  });

  it('completes a queued watcher run from complete_window provenance', async () => {
    const { sql, dbClient, workspace, api, entityId, watcherId, agent } = await createAutomatedWatcher();

    await createTestEvent({
      entity_id: entityId,
      organization_id: workspace.org.id,
      content: 'Customer feedback that should be summarized.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(dbClient, watcherId, granularity);
    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    await sql`
      UPDATE runs
      SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`}
      WHERE id = ${queued.runId}
    `;

    const content = (await api.knowledge.read({ watcher_id: watcherId })) as {
      window_token: string;
      window_start: string;
      window_end: string;
    };
    expect(content.window_start).toBe(windowStart.toISOString());
    expect(content.window_end).toBe(windowEnd.toISOString());

    const completion = (await api.watchers.completeWindow({
      watcher_id: String(watcherId),
      window_token: content.window_token,
      extracted_data: { summary: 'Automated watcher summary' },
      run_metadata: {
        executor: 'lobu-agent',
        agent_id: agent.agentId,
        watcher_run_id: queued.runId,
        dispatch_source: 'scheduled',
      },
    })) as { action: string; window_id: number };

    const [run] = await sql`
      SELECT status, window_id
      FROM runs
      WHERE id = ${queued.runId}
    `;

    expect(completion.action).toBe('complete_window');
    expect(String(run.status)).toBe('completed');
    expect(Number(run.window_id)).toBe(completion.window_id);
  });

  it('skips watcher runs pinned to a device worker (#802)', async () => {
    const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();

    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(dbClient, watcherId, granularity);
    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    // Pin the run to a device worker — the dispatcher in #798 will set this
    // when the watcher is bound to a Mac/CLI device. Until that lands the
    // server-side claim path must already refuse to grab the row.
    await sql`
      UPDATE runs
      SET approved_input = approved_input || ${sql.json({ device_worker_id: 'mac-device-abc' })}
      WHERE id = ${queued.runId}
    `;

    const result = await dispatchPendingWatcherRuns({} as Env, { db: dbClient });

    expect(result.claimed).toBe(0);
    expect(result.dispatched).toBe(0);

    const [run] = await sql`
      SELECT status, claimed_by, claimed_at
      FROM runs
      WHERE id = ${queued.runId}
    `;
    expect(String(run.status)).toBe('pending');
    expect(run.claimed_by).toBeNull();
    expect(run.claimed_at).toBeNull();

    // Explicit runIds path must also refuse to claim — the dispatcher's
    // queueAndDispatchWatcherRun helper hits this branch when a watcher run
    // is manually triggered.
    const targeted = await dispatchPendingWatcherRuns({} as Env, {
      db: dbClient,
      runIds: [queued.runId],
    });
    expect(targeted.claimed).toBe(0);

    const [stillPending] = await sql`
      SELECT status FROM runs WHERE id = ${queued.runId}
    `;
    expect(String(stillPending.status)).toBe('pending');
  });

  it('paginates watcher reads by cursor and completes from multiple page tokens', async () => {
    const { sql, workspace, api, entityId, watcherId } = await createAutomatedWatcher();

    const base = Date.UTC(2026, 0, 2, 12, 0, 0);
    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        await createTestEvent({
          entity_id: entityId,
          organization_id: workspace.org.id,
          title: `Paginated event ${i}`,
          content: `Paginated watcher content ${i}`,
          occurred_at: new Date(base - i * 60_000),
        })
      );
    }

    const page1 = (await api.knowledge.read({
      watcher_id: watcherId,
      since: '2026-01-02',
      until: '2026-01-02',
      limit: 2,
    })) as {
      content: Array<{ id: number; occurred_at: string }>;
      window_token: string;
      page: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
    };

    expect(page1.content.map((item) => item.id)).toEqual([events[0].id, events[1].id]);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.next_cursor).toBeDefined();

    const page2 = (await api.knowledge.read({
      watcher_id: watcherId,
      since: '2026-01-02',
      until: '2026-01-02',
      limit: 2,
      before_occurred_at: page1.page.next_cursor!.occurred_at,
      before_id: page1.page.next_cursor!.id,
    })) as {
      content: Array<{ id: number }>;
      window_token: string;
      page: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
    };

    expect(page2.content.map((item) => item.id)).toEqual([events[2].id, events[3].id]);
    expect(page2.page.has_more).toBe(true);

    const completion = (await api.watchers.completeWindow({
      watcher_id: String(watcherId),
      window_tokens: [page1.window_token, page2.window_token],
      extracted_data: { summary: 'Summary across two pages' },
    })) as { action: string; window_id: number; content_linked: number };

    const links = await sql`
      SELECT event_id
      FROM watcher_window_events
      WHERE window_id = ${completion.window_id}
      ORDER BY event_id
    `;

    expect(completion.action).toBe('complete_window');
    expect(completion.content_linked).toBe(4);
    expect(links.map((row) => Number(row.event_id)).sort((a, b) => a - b)).toEqual(
      [events[0].id, events[1].id, events[2].id, events[3].id].sort((a, b) => a - b)
    );
  });

  it('links the exact signed content IDs without re-running watcher sources', async () => {
    const { sql, workspace, api, entityId, watcherId } = await createAutomatedWatcher();

    const event = await createTestEvent({
      entity_id: entityId,
      organization_id: workspace.org.id,
      content: 'Content returned to the watcher worker.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const windowStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date().toISOString();

    const windowToken = await generateWindowToken(
      {
        watcher_id: watcherId,
        window_start: windowStart,
        window_end: windowEnd,
        granularity: 'daily',
        content_count: 1,
        content_ids: [event.id],
      },
      { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env
    );

    const completion = (await api.watchers.completeWindow({
      watcher_id: String(watcherId),
      window_token: windowToken,
      extracted_data: { summary: 'Summary from exact content IDs' },
    })) as { action: string; window_id: number; content_linked: number };

    const [window] = await sql`
      SELECT content_analyzed
      FROM watcher_windows
      WHERE id = ${completion.window_id}
    `;
    const links = await sql`
      SELECT event_id
      FROM watcher_window_events
      WHERE window_id = ${completion.window_id}
    `;

    expect(completion.action).toBe('complete_window');
    expect(completion.content_linked).toBe(1);
    expect(Number(window.content_analyzed)).toBe(1);
    expect(links.map((row) => Number(row.event_id))).toEqual([event.id]);
  });

  // #798 — device-pinned watcher execution end-to-end:
  //
  //   watcher.device_worker_id set
  //     → materializeDueWatcherRuns persists the pin into approved_input
  //     → server-side dispatcher refuses to claim (#802 covers this; checked
  //       above by the "skips watcher runs pinned to a device worker" test)
  //     → device posts to /api/workers/me/runs/:id/complete-watcher
  //         which writes the watcher_windows row + advances last_fired_at.
  describe('device-pinned execution (#798)', () => {
    it('persists watchers.device_worker_id and agent_kind into approved_input on materialization', async () => {
      const { sql, watcherId } = await createAutomatedWatcher();

      // Register a device worker to anchor the foreign key.
      const [device] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES ('user-watcher-pin', 'device-pin-1', 'macos', ${sql.json({})}, 'My Mac')
        RETURNING id
      `;
      const deviceWorkerId = String((device as { id: unknown }).id);

      await sql`
        UPDATE watchers
        SET device_worker_id = ${deviceWorkerId}::uuid,
            agent_kind = 'claude-code'
        WHERE id = ${watcherId}
      `;

      const result = await materializeDueWatcherRuns({} as Env);
      expect(result.runsCreated).toBe(1);

      const [run] = await sql`
        SELECT approved_input
        FROM runs
        WHERE watcher_id = ${watcherId}
          AND run_type = 'watcher'
      `;
      const payload = run.approved_input as Record<string, unknown>;
      expect(payload.device_worker_id).toBe(deviceWorkerId);
      expect(payload.agent_kind).toBe('claude-code');
    });

    it('complete-watcher endpoint records a completed run + window + last_fired_at', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );

      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '11111111-1111-1111-1111-111111111111',
        agentKind: 'claude-code',
      });

      // Move the run into `running` claimed by a specific worker — the device
      // path normally claims via /api/workers/poll; we shortcut here.
      const workerId = 'mac-device-cli-test';
      await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

      const response = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: {
            worker_id: workerId,
            output: 'CLI says: looked at 5 events, no anomalies.',
            duration_ms: 1234,
          },
        }
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; status: string };
      expect(json.ok).toBe(true);
      expect(json.status).toBe('completed');

      const [run] = await sql`
        SELECT status, completed_at, window_id, exit_reason
        FROM runs
        WHERE id = ${queued.runId}
      `;
      expect(String(run.status)).toBe('completed');
      expect(run.completed_at).not.toBeNull();
      expect(Number(run.window_id)).toBeGreaterThan(0);

      const [window] = await sql`
        SELECT extracted_data, run_metadata, execution_time_ms, model_used, granularity
        FROM watcher_windows
        WHERE id = ${run.window_id}
      `;
      const extracted = window.extracted_data as Record<string, unknown>;
      expect(extracted.kind).toBe('device_cli_output');
      expect(extracted.output).toBe('CLI says: looked at 5 events, no anomalies.');
      expect(extracted.agent_kind).toBe('claude-code');
      expect(Number(window.execution_time_ms)).toBe(1234);
      expect(String(window.model_used)).toBe('device-cli');
      expect(String(window.granularity)).toBe('ad_hoc');
      const metadata = window.run_metadata as Record<string, unknown>;
      expect(metadata.source).toBe('device_worker');
      expect(metadata.watcher_run_id).toBe(queued.runId);

      const [watcher] = await sql`
        SELECT last_fired_at
        FROM watchers
        WHERE id = ${watcherId}
      `;
      expect(watcher.last_fired_at).not.toBeNull();
    });

    it('complete-watcher endpoint marks the run failed when error is supplied', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );

      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '11111111-1111-1111-1111-111111111111',
        agentKind: 'claude-code',
      });

      const workerId = 'mac-device-cli-fail';
      await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

      const response = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: {
            worker_id: workerId,
            error: 'claude binary not found',
            duration_ms: 12,
            exit_reason: 'crash',
            exit_code: 127,
          },
        }
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as { ok: boolean; status: string };
      expect(json.status).toBe('failed');

      const [run] = await sql`
        SELECT status, error_message, window_id, exit_code, exit_reason
        FROM runs
        WHERE id = ${queued.runId}
      `;
      expect(String(run.status)).toBe('failed');
      expect(String(run.error_message)).toBe('claude binary not found');
      // No watcher_windows row on failure.
      expect(run.window_id).toBeNull();
      expect(Number(run.exit_code)).toBe(127);
      expect(String(run.exit_reason)).toBe('crash');

      const windows = await sql`
        SELECT id FROM watcher_windows WHERE run_id = ${queued.runId}
      `;
      expect(windows).toHaveLength(0);
    });

    it('complete-watcher endpoint refuses non-watcher run types', async () => {
      const sql = getTestDb();
      const { workspace } = await createAutomatedWatcher();

      const [authRun] = await sql`
        INSERT INTO runs (organization_id, run_type, approval_status, status, created_at)
        VALUES (${workspace.org.id}, 'sync', 'auto', 'running', current_timestamp)
        RETURNING id
      `;
      const runId = Number((authRun as { id: unknown }).id);

      const response = await post(
        `/api/workers/me/runs/${runId}/complete-watcher`,
        {
          body: { worker_id: 'any', output: '', duration_ms: 1 },
        }
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/watcher/i);
    });

    it('complete-watcher endpoint returns 404 for an unknown run id', async () => {
      const response = await post(
        '/api/workers/me/runs/999999999/complete-watcher',
        {
          body: { worker_id: 'any', output: '', duration_ms: 1 },
        }
      );
      expect(response.status).toBe(404);
    });

    // Pi review #1: schedule must advance on completion or the scheduler
    // re-fires the watcher every tick forever.
    it('advances watchers.next_run_at on successful completion', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );

      const [before] = await sql`
        SELECT next_run_at FROM watchers WHERE id = ${watcherId}
      `;
      const beforeNextRun = before.next_run_at as Date | string | null;

      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '22222222-2222-2222-2222-222222222222',
        agentKind: 'claude-code',
      });

      const workerId = 'mac-device-advance-test';
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

      const response = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: { worker_id: workerId, output: 'ok', duration_ms: 5 },
        }
      );
      expect(response.status).toBe(200);

      const [after] = await sql`
        SELECT next_run_at FROM watchers WHERE id = ${watcherId}
      `;
      const afterNextRun = after.next_run_at as Date | string | null;
      expect(afterNextRun).not.toBeNull();
      // The cron is `0 9 * * *` (daily 9am); the new tick must be strictly in
      // the future relative to the pre-completion value (which was forced
      // 10min in the past by createAutomatedWatcher).
      const beforeMs = beforeNextRun ? new Date(beforeNextRun).getTime() : 0;
      const afterMs = new Date(afterNextRun as string | Date).getTime();
      expect(afterMs).toBeGreaterThan(beforeMs);
      // And strictly in the future relative to "now".
      expect(afterMs).toBeGreaterThan(Date.now() - 1000);
    });

    // Pi review #3: a second concurrent completion must be idempotent — no
    // duplicate watcher_windows row, no 500, status reflects the winner.
    it('treats a double completion as idempotent (no duplicate window, no 500)', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );

      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '33333333-3333-3333-3333-333333333333',
        agentKind: 'claude-code',
      });

      const workerId = 'mac-device-idem-test';
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

      // First completion lands.
      const first = await post(`/api/workers/me/runs/${queued.runId}/complete-watcher`, {
        body: { worker_id: workerId, output: 'first', duration_ms: 11 },
      });
      expect(first.status).toBe(200);

      // Second completion against the now-terminal row must NOT 500.
      // `authorizeRunForWorker` will return 409 first (status no longer
      // 'running'); the in-tx FOR UPDATE / idempotent branch is exercised by
      // the truly-concurrent case (post-claim, pre-commit), which a single
      // serialized test runner can't easily reproduce — but we DO assert
      // that no extra watcher_windows row was created either way.
      const second = await post(`/api/workers/me/runs/${queued.runId}/complete-watcher`, {
        body: { worker_id: workerId, output: 'second', duration_ms: 12 },
      });
      expect([200, 409]).toContain(second.status);

      const windowsForRun = await sql`
        SELECT id FROM watcher_windows WHERE run_id = ${queued.runId}
      `;
      expect(windowsForRun).toHaveLength(1);

      const [run] = await sql`
        SELECT status FROM runs WHERE id = ${queued.runId}
      `;
      expect(String(run.status)).toBe('completed');
    });

    // Pi review #5: malformed window bounds in approved_input must fail the
    // run and advance the schedule, not leave it stuck in 'running'.
    it('marks run failed (not stuck running) on malformed approved_input', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );
      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '44444444-4444-4444-4444-444444444444',
        agentKind: 'claude-code',
      });
      const workerId = 'mac-device-malformed-test';
      // Corrupt the approved_input window_start so completion validation
      // rejects it. The run is still claimed/running.
      await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId},
            approved_input = approved_input || ${sql.json({ window_start: 'not-a-date' })}
        WHERE id = ${queued.runId}
      `;

      const [before] = await sql`SELECT next_run_at FROM watchers WHERE id = ${watcherId}`;
      const beforeNextRun = before.next_run_at as Date | string | null;

      const response = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: { worker_id: workerId, output: 'whatever', duration_ms: 1 },
        }
      );
      expect(response.status).toBe(400);

      const [run] = await sql`
        SELECT status, error_message FROM runs WHERE id = ${queued.runId}
      `;
      expect(String(run.status)).toBe('failed');
      expect(String(run.error_message)).toMatch(/window_start/);

      const [after] = await sql`SELECT next_run_at FROM watchers WHERE id = ${watcherId}`;
      const afterNextRun = after.next_run_at as Date | string | null;
      const beforeMs = beforeNextRun ? new Date(beforeNextRun).getTime() : 0;
      const afterMs = afterNextRun ? new Date(afterNextRun).getTime() : 0;
      expect(afterMs).toBeGreaterThan(beforeMs);
    });

    // Pi review round-2 #A: device spoof — a same-user token bound to worker
    // A cannot complete a run pinned to worker B by lying in body.worker_id.
    // Previously the binding check was `(user_id, body.worker_id)`, which a
    // same-user attacker could satisfy by registering worker B and POSTing
    // worker B's id. The fix anchors on the OAuth-token-bound workerId.
    it('rejects device spoof — token bound to worker A cannot complete worker B run', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();

      // Two registered device workers under the SAME user.
      const ownerUserId = workspace.users.owner.id;
      const [deviceA] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'worker-A', 'macos', ${sql.json({})}, 'Mac A')
        RETURNING id
      `;
      const [deviceB] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'worker-B', 'macos', ${sql.json({})}, 'Mac B')
        RETURNING id
      `;
      const deviceBId = String((deviceB as { id: unknown }).id);
      // deviceA.id is referenced via the bound PAT — no further use here.
      void deviceA;

      // Token bound to worker A.
      const { token: patForA } = await createWorkerBoundPat(
        ownerUserId,
        workspace.org.id,
        'worker-A'
      );

      // Watcher run pinned to worker B (via approved_input.device_worker_id).
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );
      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: deviceBId,
        agentKind: 'claude-code',
      });
      // Claim the run as worker B so `authorizeRunForWorker` passes its
      // claimed_by check when the body posts worker_id=worker-B. The new
      // bound-workerId check (Fix A) is what should fire instead.
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = 'worker-B'
        WHERE id = ${queued.runId}
      `;

      const response = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          token: patForA,
          body: { worker_id: 'worker-B', output: 'spoofed', duration_ms: 1 },
        }
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/worker_id_mismatch|Forbidden/);

      // Run must still be 'running' — nothing was completed.
      const [run] = await sql`
        SELECT status, window_id FROM runs WHERE id = ${queued.runId}
      `;
      expect(String(run.status)).toBe('running');
      expect(run.window_id).toBeNull();
      // No watcher_windows row was created.
      const windows = await sql`
        SELECT id FROM watcher_windows WHERE run_id = ${queued.runId}
      `;
      expect(windows).toHaveLength(0);
    });

    // Pi review round-2 #B: concurrent allocation race — two completions on
    // DIFFERENT watcher runs must both succeed with distinct window ids.
    // Pre-fix, both could compute the same MAX(id)+1 and the second INSERT
    // would 500 on the watcher_windows PK conflict. The advisory lock inside
    // getNextNumericId serializes them.
    it('serializes concurrent watcher_windows allocations across different runs', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();

      // A second watcher in the same org so the two runs touch different
      // `runs.id` rows AND different `watchers.id` (the SELECT … FOR UPDATE
      // in the completeWatcherRun tx is per-row, so cross-watcher concurrent
      // completions only collide on the watcher_windows allocator).
      const secondEntity = await createTestEntity({
        name: 'Second Entity',
        organization_id: workspace.org.id,
        created_by: workspace.users.owner.id,
      });
      const secondWatcher = (await workspace.owner.watchers.create({
        entity_id: secondEntity.id,
        slug: 'automation-watcher-2',
        name: 'Automation Watcher 2',
        prompt: 'Summarize content for {{entities}}.',
        extraction_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        schedule: '0 9 * * *',
        agent_id: agent.agentId,
      })) as { watcher_id: string };
      const watcherId2 = Number(secondWatcher.watcher_id);

      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );
      const queuedA = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '55555555-5555-5555-5555-555555555555',
        agentKind: 'claude-code',
      });
      const queuedB = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId: watcherId2,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '66666666-6666-6666-6666-666666666666',
        agentKind: 'claude-code',
      });

      const workerIdA = 'mac-device-concurrent-A';
      const workerIdB = 'mac-device-concurrent-B';
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerIdA}
        WHERE id = ${queuedA.runId}
      `;
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerIdB}
        WHERE id = ${queuedB.runId}
      `;

      // Fire both completions concurrently. With the per-table advisory lock
      // they serialize on the SELECT MAX(id) and INSERT, so both succeed.
      const [respA, respB] = await Promise.all([
        post(`/api/workers/me/runs/${queuedA.runId}/complete-watcher`, {
          body: { worker_id: workerIdA, output: 'A', duration_ms: 1 },
        }),
        post(`/api/workers/me/runs/${queuedB.runId}/complete-watcher`, {
          body: { worker_id: workerIdB, output: 'B', duration_ms: 1 },
        }),
      ]);
      expect(respA.status).toBe(200);
      expect(respB.status).toBe(200);

      // Both runs completed.
      const runs = await sql`
        SELECT id, status, window_id
        FROM runs
        WHERE id IN (${queuedA.runId}, ${queuedB.runId})
        ORDER BY id
      `;
      expect(runs).toHaveLength(2);
      for (const row of runs) {
        expect(String(row.status)).toBe('completed');
        expect(Number(row.window_id)).toBeGreaterThan(0);
      }

      // Window ids are distinct (no PK conflict, no two rows under the same id).
      const windows = await sql`
        SELECT id, run_id
        FROM watcher_windows
        WHERE run_id IN (${queuedA.runId}, ${queuedB.runId})
        ORDER BY id
      `;
      expect(windows).toHaveLength(2);
      const ids = windows.map((w) => Number((w as { id: unknown }).id));
      expect(new Set(ids).size).toBe(2);
    });

    // Pi review round-2 #C: malformed-completion double-advance — two
    // concurrent malformed POSTs against the same run must only advance the
    // schedule once. Without the RETURNING-gated advance, the second POST's
    // UPDATE matches zero rows (status already 'failed') but still ticked
    // next_run_at forward.
    it('does not double-advance next_run_at on concurrent malformed completions', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );
      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '77777777-7777-7777-7777-777777777777',
        agentKind: 'claude-code',
      });
      const workerId = 'mac-device-double-advance';
      // Poison window_start and claim the run.
      await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId},
            approved_input = approved_input || ${sql.json({ window_start: 'not-a-date' })}
        WHERE id = ${queued.runId}
      `;

      // Capture next_run_at after the FIRST malformed completion lands.
      const first = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: { worker_id: workerId, output: 'x', duration_ms: 1 },
        }
      );
      expect(first.status).toBe(400);
      const [afterFirst] = await sql`
        SELECT next_run_at FROM watchers WHERE id = ${watcherId}
      `;
      const firstNextRunMs = new Date(
        afterFirst.next_run_at as string | Date
      ).getTime();

      // Second malformed completion against the now-failed row. The validation
      // error still fires (approved_input.window_start is still garbage), but
      // the UPDATE … WHERE status='running' matches zero rows, so the schedule
      // must NOT advance again.
      const second = await post(
        `/api/workers/me/runs/${queued.runId}/complete-watcher`,
        {
          body: { worker_id: workerId, output: 'x2', duration_ms: 1 },
        }
      );
      expect(second.status).toBe(400);
      const [afterSecond] = await sql`
        SELECT next_run_at FROM watchers WHERE id = ${watcherId}
      `;
      const secondNextRunMs = new Date(
        afterSecond.next_run_at as string | Date
      ).getTime();

      expect(secondNextRunMs).toBe(firstNextRunMs);
    });
  });

  // Regression: an active watcher run carrying a `dispatched_message_id` must
  // not crash reconciliation. The dispatched-id containment query bound the JS
  // array straight into `= ANY(${ids})`. The production pool (db/client.ts) runs
  // with `fetch_types: false`, so postgres.js can't infer the array element type
  // and ships the lone element as a scalar — PG then throws
  // `malformed array literal: "<uuid>"`. Because `watcher-automation` (every
  // tick) AND `check-stalled-executions` both call reconcileWatcherRuns, a single
  // such run wedged BOTH jobs — watchers stopped firing in prod for 12 days (run
  // 146501 stuck `running` since 2026-05-13, which also blocked the reaper that
  // would have cleared it). Fix: bind via pgTextArray(...)::text[], the same
  // explicit-literal idiom every other ANY() in this file already uses.
  //
  // NOTE: this MUST exercise getDb() (the prod pool with fetch_types:false), not
  // the test-harness client — the latter fetches types and silently masks the
  // bug. Both clients point at the same DATABASE_URL test database here.
  it('reconciles without crashing when an active run carries a dispatched_message_id', async () => {
    const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(dbClient, watcherId, granularity);
    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    // Move the run to an active state with a dispatched_message_id and NO
    // watcher_windows row — mirrors prod's stuck run 146501 exactly, so the
    // first reconcile query is a no-op and execution reaches the buggy
    // dispatched-id containment query.
    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_at = NOW(),
          claimed_by = ${`lobu:${agent.agentId}`},
          dispatched_message_id = 'f7623d32-b589-4085-9504-edbf30925961'
      WHERE id = ${queued.runId}
    `;

    // Pre-fix this rejects with `malformed array literal`; post-fix it resolves.
    const result = await reconcileWatcherRuns(getDb());
    expect(result.reconciled).toBe(0);
  });

  describe('watcher-automation tick orchestration', () => {
    // End-to-end regression for the 12-day outage: a stuck active run carrying a
    // dispatched_message_id used to make reconcile throw `malformed array literal`,
    // which (pre phase-isolation) aborted materialize + dispatch every tick. The
    // tick must now (a) not surface a reconcile error and (b) still materialize a
    // separate due watcher.
    it('survives a wedging in-flight run and still materializes other due watchers', async () => {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();

      // Watcher A: a stuck active run with a dispatched_message_id and no window —
      // the exact shape of prod run 146501 that wedged reconcile.
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(dbClient, watcherId, granularity);
      const stuck = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
      });
      await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`},
            dispatched_message_id = 'f7623d32-b589-4085-9504-edbf30925961'
        WHERE id = ${stuck.runId}
      `;

      // Watcher B: due, no active run, valid agent → must materialize this tick.
      const entityB = await createTestEntity({
        name: 'Tick Entity B',
        organization_id: workspace.org.id,
        created_by: workspace.users.owner.id,
      });
      const watcherB = (await workspace.owner.watchers.create({
        entity_id: entityB.id,
        slug: 'tick-watcher-b',
        name: 'Tick Watcher B',
        prompt: 'Summarize content for {{entities}}.',
        extraction_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        schedule: '0 9 * * *',
        agent_id: agent.agentId,
      })) as { watcher_id: string };
      const watcherBId = Number(watcherB.watcher_id);
      await sql`UPDATE watchers SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${watcherBId}`;

      const result = await runWatcherAutomationTick({} as Env);

      // No phase threw — the bind fix means reconcile handles the dispatched-id
      // array, and isolation means a phase failure wouldn't starve the rest.
      expect(result.errors).toEqual([]);
      // Watcher B materialized despite watcher A's stuck run.
      expect(result.runsCreated).toBeGreaterThanOrEqual(1);
      const [runB] = await sql`
        SELECT status FROM runs
        WHERE watcher_id = ${watcherBId} AND run_type = 'watcher'
      `;
      expect(runB).toBeDefined();
    });

    // Item 1: a watcher whose assigned agent no longer exists (and isn't device
    // pinned) must NOT be scheduled — no doomed run per tick — and be counted as
    // unrunnable for visibility. Mirrors prod orgs lobu-crm / lobu-team.
    it('does not schedule a watcher whose agent does not exist; counts it unrunnable', async () => {
      const { sql, watcherId } = await createAutomatedWatcher();

      // Point the watcher at a non-existent agent, no device pin, due now.
      await sql`
        UPDATE watchers
        SET agent_id = 'ghost-agent-deleted', device_worker_id = NULL,
            next_run_at = NOW() - INTERVAL '10 minutes'
        WHERE id = ${watcherId}
      `;

      const result = await materializeDueWatcherRuns({} as Env);

      expect(result.runsCreated).toBe(0);
      expect(result.unrunnable).toBeGreaterThanOrEqual(1);
      const runs = await sql`
        SELECT id FROM runs WHERE watcher_id = ${watcherId} AND run_type = 'watcher'
      `;
      expect(runs).toHaveLength(0);
    });
  });

  describe('sweepStaleWatcherRuns liveness reaping', () => {
    // Seed a `running` watcher run with controlled claim/heartbeat ages.
    // Omitting `heartbeatAgo` mirrors a client that never heartbeats — the
    // claim sets last_heartbeat_at == claimed_at, so the row must fall to the
    // coarse 2h path, never the fast heartbeat path.
    async function seedRunningWatcherRun(opts: {
      claimedAgo: string;
      heartbeatAgo?: string;
    }) {
      const { sql, dbClient, workspace, watcherId, agent } = await createAutomatedWatcher();
      const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
      const { windowStart, windowEnd } = await computePendingWindow(
        dbClient,
        watcherId,
        granularity
      );
      const queued = await createWatcherRun({
        organizationId: workspace.org.id,
        watcherId,
        agentId: agent.agentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        dispatchSource: 'scheduled',
        deviceWorkerId: '11111111-1111-1111-1111-111111111111',
        agentKind: 'claude-code',
      });
      const heartbeatAgo = opts.heartbeatAgo ?? opts.claimedAgo;
      await sql`
        UPDATE runs
        SET status = 'running',
            claimed_by = 'mac-sweep-test',
            claimed_at = NOW() - ${opts.claimedAgo}::interval,
            last_heartbeat_at = NOW() - ${heartbeatAgo}::interval
        WHERE id = ${queued.runId}
      `;
      return { sql, runId: queued.runId };
    }

    it('reaps a heartbeating run that went silent past the heartbeat window', async () => {
      // Beat once after claim (10m ago > claim 1h ago), then silent >3min.
      const { sql, runId } = await seedRunningWatcherRun({
        claimedAgo: '1 hour',
        heartbeatAgo: '10 minutes',
      });
      const { timedOut } = await sweepStaleWatcherRuns(sql);
      expect(timedOut).toBeGreaterThanOrEqual(1);
      const [row] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
      expect(String(row.status)).toBe('timeout');
      expect(String(row.error_message ?? '')).toMatch(/heartbeat went silent/i);
    });

    it('leaves a run with a fresh heartbeat running', async () => {
      const { sql, runId } = await seedRunningWatcherRun({
        claimedAgo: '1 hour',
        heartbeatAgo: '30 seconds',
      });
      await sweepStaleWatcherRuns(sql);
      const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(String(row.status)).toBe('running');
    });

    it('does not coarse-reap a live heartbeating run older than the 2h TTL', async () => {
      // Claimed 3h ago but heartbeating fresh (30s) → still alive. The coarse
      // 2h backstop must NOT touch it; only the (un-lapsed) fast path governs
      // a heartbeating run. Guards against killing a legitimately long turn.
      const { sql, runId } = await seedRunningWatcherRun({
        claimedAgo: '3 hours',
        heartbeatAgo: '30 seconds',
      });
      await sweepStaleWatcherRuns(sql);
      const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(String(row.status)).toBe('running');
    });

    it('does not fast-reap a recent run that never heartbeats', async () => {
      // last_heartbeat_at == claimed_at (no beat) + only 30m old → the fast
      // path must NOT fire; it stays running until the 2h coarse backstop.
      // Backward-compat guard for clients that do not heartbeat.
      const { sql, runId } = await seedRunningWatcherRun({ claimedAgo: '30 minutes' });
      await sweepStaleWatcherRuns(sql);
      const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(String(row.status)).toBe('running');
    });

    it('reaps a non-heartbeating run via the coarse 2h backstop', async () => {
      const { sql, runId } = await seedRunningWatcherRun({ claimedAgo: '3 hours' });
      const { timedOut } = await sweepStaleWatcherRuns(sql);
      expect(timedOut).toBeGreaterThanOrEqual(1);
      const [row] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
      expect(String(row.status)).toBe('timeout');
      expect(String(row.error_message ?? '')).toMatch(/2 hours/i);
    });
  });
});
