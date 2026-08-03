import { inferBehaviorGranularityFromSchedule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { createWatcherRun } from '../../../runs/queue-service';
import { persistBehaviorEventOutput } from '../../../utils/persist-behavior-event-output';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

describe('Behavior event outputs', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('appends multiple run-linked events and deduplicates a completion retry', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Behavior Event Output Org' });
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Observed account',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'event-output-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    const created = (await api.behaviors.create({
      entity_id: parent.id,
      slug: 'event-output-behavior',
      prompt: 'Return notable observations as standard event drafts.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: {
        observations: { event: 'observation' },
        drafts: { event: 'draft_reply' },
      },
      agent_id: agent.agentId,
    })) as { behavior_id: string };
    const watcherId = Number(created.behavior_id);
    await sql`UPDATE watchers SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${watcherId}`;

    const granularity = inferBehaviorGranularityFromSchedule('0 9 * * *');
    const pending = await computePendingWindow(sql as unknown as DbClient, watcherId, granularity);
    const source = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'A source event the Behavior can reply to.',
      occurred_at: new Date(pending.windowStart.getTime() + 60 * 60 * 1000),
    });
    const queued = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: pending.windowStart.toISOString(),
      windowEnd: pending.windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });
    await sql`
      UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`}
      WHERE id = ${queued.runId}
    `;
    const knowledge = (await api.knowledge.read({ behavior_id: watcherId })) as {
      window_token: string;
    };
    const extracted = {
      observations: [
        {
          title: 'Source reply',
          content: 'This is linked to the source event.',
          parent_event_id: source.id,
          idempotency_key: source.origin_id,
          metadata: { rank: 1 },
        },
        {
          title: 'Independent observation',
          content: 'This is another event from the same Behavior run.',
          payload_type: 'markdown',
          metadata: { rank: 2 },
        },
      ],
      drafts: [
        {
          title: 'Draft reply to source',
          content: 'A reply the human can review before publishing.',
          parent_event_id: source.id,
          idempotency_key: `draft:${source.origin_id}`,
          metadata: {
            platform: 'linkedin',
            source_origin_id: source.origin_id,
            source_event_id: source.id,
          },
        },
      ],
    };

    const complete = () =>
      api.behaviors.completeWindow({
        behavior_id: String(watcherId),
        window_token: knowledge.window_token,
        extracted_data: extracted,
        behavior_run_id: queued.runId,
      });
    const firstCompletion = (await complete()) as { window_id: number };
    await complete();

    const rows = await sql<{
      id: number;
      run_id: number;
      semantic_type: string;
      origin_parent_id: string | null;
      metadata: Record<string, unknown>;
    }>`
      SELECT id, run_id, semantic_type, origin_parent_id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'behavior_output' IN ('observations', 'drafts')
      ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => Number(row.run_id) === queued.runId)).toBe(true);
    const observations = rows.filter(
      (row) => row.metadata.behavior_output === 'observations'
    );
    const draft = rows.find((row) => row.metadata.behavior_output === 'drafts');
    expect(observations).toHaveLength(2);
    expect(observations[0].origin_parent_id).toBe(source.origin_id);
    expect(observations[1].origin_parent_id).toBeNull();
    expect(draft).toMatchObject({
      semantic_type: 'draft_reply',
      origin_parent_id: source.origin_id,
    });
    expect(observations.map((row) => Number(row.metadata.rank))).toEqual([1, 2]);

    // A source-derived idempotency key is intentionally stronger than a run
    // retry key: a later run that rediscovers the same post reuses the original
    // event instead of appending a duplicate.
    const laterRun = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId: agent.agentId,
      windowStart: pending.windowStart.toISOString(),
      windowEnd: pending.windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });
    const reused = await sql.begin(async (tx) =>
      persistBehaviorEventOutput({
        tx: tx as unknown as DbClient,
        rows: [extracted.observations[0]],
        outputName: 'observations',
        output: { event: 'observation' },
        watcherId,
        organizationId: workspace.org.id,
        windowId: firstCompletion.window_id,
        runId: laterRun.runId,
        boundEntityIds: [parent.id],
        validContentIds: new Set([source.id]),
        occurredAt: pending.windowEnd.toISOString(),
        createdBy: ownerUserId,
      })
    );
    expect(reused).toHaveLength(1);
    expect(reused[0].id).toBe(observations[0].id);

    await expect(
      sql.begin((tx) =>
        persistBehaviorEventOutput({
          tx: tx as unknown as DbClient,
          rows: [
            { content: 'First draft', idempotency_key: 'duplicate-in-one-output' },
            { content: 'Different draft', idempotency_key: 'duplicate-in-one-output' },
          ],
          outputName: 'drafts',
          output: { event: 'draft_reply' },
          watcherId,
          organizationId: workspace.org.id,
          windowId: firstCompletion.window_id,
          runId: laterRun.runId,
          boundEntityIds: [parent.id],
          validContentIds: new Set([source.id]),
          occurredAt: pending.windowEnd.toISOString(),
          createdBy: ownerUserId,
        })
      )
    ).rejects.toThrow(/duplicate.*idempotency/i);
  });
});
