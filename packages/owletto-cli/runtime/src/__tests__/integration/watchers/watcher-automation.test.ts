import { inferWatcherGranularityFromSchedule } from '@lobu/owletto-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import * as lobuGateway from '../../../lobu/gateway';
import { checkStalledExecutions } from '../../../scheduled/check-stalled-executions';
import { createWatcherRun } from '../../../utils/queue-helpers';
import { computePendingWindow } from '../../../utils/window-utils';
import {
  dispatchPendingWatcherRuns,
  materializeDueWatcherRuns,
  reconcileWatcherRuns,
} from '../../../watchers/automation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  createTestWatcher,
  createTestWatcherTemplate,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createAutomatedWatcher() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const org = await createTestOrganization({ name: 'Watcher Automation Org' });
  const user = await createTestUser({ email: 'watcher-automation@test.com' });
  await addUserToOrganization(user.id, org.id, 'owner');

  const entity = await createTestEntity({
    name: 'Automation Entity',
    organization_id: org.id,
    entity_type: 'brand',
  });

  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
    agentId: 'watcher-agent',
    name: 'Watcher Agent',
  });

  const template = await createTestWatcherTemplate({
    slug: 'watcher-automation-template',
    name: 'Watcher Automation Template',
    organization_id: org.id,
    entity_id: entity.id,
    prompt: 'Summarize the content for {{entities}}',
    output_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  });

  const watcher = await createTestWatcher({
    entity_id: entity.id,
    template_id: template.id,
    organization_id: org.id,
    schedule: '0 9 * * *',
    agent_id: agent.agentId,
  });

  await sql`
    UPDATE watchers
    SET next_run_at = NOW() - INTERVAL '10 minutes'
    WHERE id = ${watcher.id}
  `;

  const client = await createTestOAuthClient();
  const token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

  return { sql, dbClient, org, user, entity, agent, watcher, token };
}

describe('watcher automation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('materializes one scheduled watcher run and prevents duplicates under concurrent ticks', async () => {
    const { sql, watcher, agent, org } = await createAutomatedWatcher();

    const [resultA, resultB] = await Promise.all([
      materializeDueWatcherRuns({} as Env),
      materializeDueWatcherRuns({} as Env),
    ]);

    const runs = await sql`
      SELECT id, status, approved_input
      FROM runs
      WHERE watcher_id = ${watcher.id}
        AND run_type = 'watcher'
        AND organization_id = ${org.id}
    `;

    expect(runs.length).toBe(1);
    expect(resultA.runsCreated + resultB.runsCreated).toBe(1);
    expect(String(runs[0].status)).toBe('pending');

    const payload = (runs[0] as { approved_input: Record<string, unknown> }).approved_input;
    expect(Number(payload.watcher_id)).toBe(watcher.id);
    expect(String(payload.agent_id)).toBe(agent.agentId);
    expect(String(payload.dispatch_source)).toBe('scheduled');
  });

  it('does not materialize scheduled watcher runs when no agent is assigned', async () => {
    const { sql, org, entity } = await createAutomatedWatcher();

    const template = await createTestWatcherTemplate({
      slug: 'watcher-without-agent',
      name: 'Watcher Without Agent',
      organization_id: org.id,
      entity_id: entity.id,
    });

    const watcher = await createTestWatcher({
      entity_id: entity.id,
      template_id: template.id,
      organization_id: org.id,
      schedule: '0 9 * * *',
    });

    await sql`
      UPDATE watchers
      SET next_run_at = NOW() - INTERVAL '10 minutes',
          agent_id = NULL
      WHERE id = ${watcher.id}
    `;

    await materializeDueWatcherRuns({} as Env);
    const runs = await sql`
      SELECT id FROM runs WHERE watcher_id = ${watcher.id} AND run_type = 'watcher'
    `;

    expect(runs.length).toBe(0);
  });

  it('dispatches queued watcher runs through embedded Lobu and marks them running', async () => {
    const { sql, dbClient, org, watcher, agent } = await createAutomatedWatcher();
    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(
      dbClient,
      watcher.id,
      granularity
    );

    const queued = await createWatcherRun({
      organizationId: org.id,
      watcherId: watcher.id,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    vi.spyOn(lobuGateway, 'isLobuGatewayRunning').mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8787/lobu/api/v1/agents' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          agentId: `${agent.agentId}_${agent.agentId}`,
          messagesUrl: `http://127.0.0.1:8787/lobu/api/v1/agents/${agent.agentId}_${agent.agentId}/messages`,
        });
      }

      if (
        url ===
          `http://127.0.0.1:8787/lobu/api/v1/agents/${agent.agentId}_${agent.agentId}/messages` &&
        init?.method === 'POST'
      ) {
        const body = JSON.parse(String(init.body)) as { content: string };
        expect(body.content).toContain(`Watcher run ID: ${queued.runId}`);
        expect(body.content).toContain(`Assigned agent ID: ${agent.agentId}`);
        expect(body.content).toContain(`"since": "${windowStart.toISOString().split('T')[0]}"`);
        expect(body.content).toContain(
          `"until": "${new Date(new Date(windowEnd).getTime() - 1).toISOString().split('T')[0]}"`
        );
        return jsonResponse({ success: true, queued: true });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await dispatchPendingWatcherRuns({} as Env, {
      db: dbClient,
      runIds: [queued.runId],
    });
    const [run] = await sql`
      SELECT status, claimed_by
      FROM runs
      WHERE id = ${queued.runId}
    `;

    expect(result.dispatched).toBe(1);
    expect(String(run.status)).toBe('running');
    expect(String(run.claimed_by)).toBe(`lobu:${agent.agentId}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks watcher runs completed when an external completion already created the queued window', async () => {
    const { sql, dbClient, org, watcher, agent } = await createAutomatedWatcher();
    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(
      dbClient,
      watcher.id,
      granularity
    );

    const queued = await createWatcherRun({
      organizationId: org.id,
      watcherId: watcher.id,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    const [window] = await sql`
      INSERT INTO watcher_windows (
        watcher_id,
        granularity,
        window_start,
        window_end,
        extracted_data,
        content_analyzed,
        model_used,
        run_metadata,
        created_at
      ) VALUES (
        ${watcher.id},
        'daily',
        ${windowStart},
        ${windowEnd},
        ${sql.json({ summary: 'External completion' })},
        1,
        'external-client',
        ${sql.json({ source: 'external' })},
        NOW()
      )
      RETURNING id
    `;

    const reconciliation = await reconcileWatcherRuns(dbClient);
    const [run] = await sql`
      SELECT status, window_id
      FROM runs
      WHERE id = ${queued.runId}
    `;

    expect(reconciliation.reconciled).toBe(1);
    expect(String(run.status)).toBe('completed');
    expect(Number(run.window_id)).toBe(Number(window.id));
  });

  it('times out stalled watcher runs and retries the same queued window', async () => {
    const { sql, dbClient, org, watcher, agent } = await createAutomatedWatcher();
    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(
      dbClient,
      watcher.id,
      granularity
    );

    const queued = await createWatcherRun({
      organizationId: org.id,
      watcherId: watcher.id,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_at = NOW() - INTERVAL '10 minutes',
          last_heartbeat_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${queued.runId}
    `;

    await checkStalledExecutions({} as Env);

    const runs = await sql`
      SELECT id, status, approved_input
      FROM runs
      WHERE watcher_id = ${watcher.id}
        AND run_type = 'watcher'
      ORDER BY id ASC
    `;

    expect(runs).toHaveLength(2);
    expect(String(runs[0].status)).toBe('timeout');
    expect(String(runs[1].status)).toBe('pending');
    expect((runs[0] as { approved_input: unknown }).approved_input).toEqual(
      (runs[1] as { approved_input: unknown }).approved_input
    );
  });

  it('completes the queued watcher run from complete_window provenance and advances next_run_at', async () => {
    const { sql, dbClient, org, entity, watcher, agent, token } = await createAutomatedWatcher();

    await createTestEvent({
      entity_id: entity.id,
      organization_id: org.id,
      content: 'Customer feedback that should be summarized.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const granularity = inferWatcherGranularityFromSchedule('0 9 * * *');
    const { windowStart, windowEnd } = await computePendingWindow(
      dbClient,
      watcher.id,
      granularity
    );

    const queued = await createWatcherRun({
      organizationId: org.id,
      watcherId: watcher.id,
      agentId: agent.agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });

    const content = await mcpToolsCall<{
      window_token: string;
      window_start: string;
      window_end: string;
    }>('read_knowledge', { watcher_id: watcher.id }, { token });

    expect(content.window_start).toBe(windowStart.toISOString());
    expect(content.window_end).toBe(windowEnd.toISOString());

    const completion = await mcpToolsCall<{
      action: 'complete_window';
      watcher_id: string;
      window_id: number;
    }>(
      'manage_watchers',
      {
        action: 'complete_window',
        window_token: content.window_token,
        extracted_data: { summary: 'Automated watcher summary' },
        run_metadata: {
          executor: 'lobu-agent',
          agent_id: agent.agentId,
          watcher_run_id: queued.runId,
          dispatch_source: 'scheduled',
        },
      },
      { token }
    );

    const [run] = await sql`
      SELECT status, window_id
      FROM runs
      WHERE id = ${queued.runId}
    `;
    const [watcherRow] = await sql`
      SELECT next_run_at
      FROM watchers
      WHERE id = ${watcher.id}
    `;

    expect(completion.action).toBe('complete_window');
    expect(String(run.status)).toBe('completed');
    expect(Number(run.window_id)).toBe(completion.window_id);
    expect(watcherRow.next_run_at).not.toBeNull();
  });

  it('triggers an assigned watcher through manage_watchers(trigger)', async () => {
    const { sql, watcher, agent, token } = await createAutomatedWatcher();

    vi.spyOn(lobuGateway, 'isLobuGatewayRunning').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8787/lobu/api/v1/agents' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          agentId: `${agent.agentId}_${agent.agentId}`,
          messagesUrl: `http://127.0.0.1:8787/lobu/api/v1/agents/${agent.agentId}_${agent.agentId}/messages`,
        });
      }

      if (
        url ===
          `http://127.0.0.1:8787/lobu/api/v1/agents/${agent.agentId}_${agent.agentId}/messages` &&
        init?.method === 'POST'
      ) {
        return jsonResponse({ success: true, queued: true });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await mcpToolsCall<{ action: 'trigger'; run_id: number; status: string }>(
      'manage_watchers',
      { action: 'trigger', watcher_id: String(watcher.id) },
      { token }
    );

    const [run] = await sql`
      SELECT status, approved_input
      FROM runs
      WHERE id = ${result.run_id}
    `;

    expect(result.action).toBe('trigger');
    expect(result.status).toBe('running');
    expect(String(run.status)).toBe('running');

    const payload = (run as { approved_input: Record<string, unknown> }).approved_input;
    expect(String(payload.dispatch_source)).toBe('manual');
  });
});
