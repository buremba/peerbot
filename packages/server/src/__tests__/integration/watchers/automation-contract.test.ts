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
import type { Env } from '../../../index';
import { generateWindowToken } from '../../../utils/jwt';
import { createWatcherRun } from '../../../utils/queue-helpers';
import { computePendingWindow } from '../../../utils/window-utils';
import {
  dispatchPendingWatcherRuns,
  materializeDueWatcherRuns,
} from '../../../watchers/automation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

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
  });
});
