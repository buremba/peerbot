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
import { createWatcherRun } from '../../../utils/queue-helpers';
import { computePendingWindow } from '../../../utils/window-utils';
import {
  dispatchPendingWatcherRuns,
  materializeDueWatcherRuns,
} from '../../../watchers/automation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { TestWorkspace } from '../../setup/test-workspace';

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
});
