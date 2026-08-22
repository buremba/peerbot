import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import { computePendingWindow } from '../../../utils/window-utils';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEntity,
  createTestEvent,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const DAY_MS = 86_400_000;

function dayStart(daysAgo: number): Date {
  const date = new Date(Date.now() - daysAgo * DAY_MS);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

type ClaimContext = {
  content: Array<{ id: number }>;
  sources_page?: Record<string, { returned: number; limit: number; has_more: boolean }>;
  window_start: string;
  window_end: string;
  window_token: string;
  page: {
    has_more: boolean;
    next_cursor?: { occurred_at: string; id: number };
  };
};

type ClaimResult = {
  action: 'claim_next_window';
  automation_id: string;
  run_id: number;
  lease_expires_at: string;
  context: ClaimContext;
};

describe('Automation window claim and recovery', () => {
  let sql: DbClient;
  let orgId: string;
  let userId: string;
  let automationId: number;
  let agentId: string;
  let entityId: number;
  let api: TestApiClient;
  let ctx: Awaited<ReturnType<typeof seedOwnerContext>>['ctx'];

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    sql = getTestDb() as unknown as DbClient;
    orgId = seeded.org.id;
    userId = seeded.user.id;
    ctx = seeded.ctx;
    const agent = await createTestAgent({
      organizationId: orgId,
      ownerUserId: userId,
      agentId: 'window-recovery-agent',
    });
    agentId = agent.agentId;
    const entity = await createTestEntity({
      name: 'Window recovery subject',
      organization_id: orgId,
      created_by: userId,
    });
    entityId = entity.id;
    api = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'window-recovery',
      name: 'Window recovery',
      prompt: 'Extract durable signals from each completed daily period.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      agent_id: agentId,
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
  });

  async function claim(input: Record<string, unknown> = {}): Promise<ClaimResult> {
    return (await api.automations.claimNextWindow({
      automation_id: String(automationId),
      ...input,
    })) as ClaimResult;
  }

  async function failRun(windowStart: Date): Promise<number> {
    const run = await createAutomationRun({
      organizationId: orgId,
      automationId,
      agentId,
      windowStart: windowStart.toISOString(),
      windowEnd: new Date(windowStart.getTime() + DAY_MS).toISOString(),
      dispatchSource: 'scheduled',
    });
    await sql`
      UPDATE runs
      SET status = 'failed', outcome = 'agent_error', completed_at = NOW(),
          error_message = 'simulated internal failure'
      WHERE id = ${run.runId}
    `;
    return run.runId;
  }

  it('recovers a first-ever failed assigned-agent window before any external claim', async () => {
    const failedStart = dayStart(4);
    const newerFailedRunId = await failRun(dayStart(3));
    const failedRunId = await failRun(failedStart);
    const superseded = await createAutomationRun({
      organizationId: orgId,
      automationId,
      agentId,
      windowStart: dayStart(2).toISOString(),
      windowEnd: dayStart(1).toISOString(),
      dispatchSource: 'scheduled',
    });
    const event = await createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: 'Source content from the failed logical period.',
      occurred_at: new Date(failedStart.getTime() + 3_600_000),
    });

    const pending = await computePendingWindow(sql, automationId, 'daily');
    expect(pending.windowStart.toISOString()).toBe(failedStart.toISOString());

    const detail = (await api.automations.get({
      automation_id: String(automationId),
    })) as {
      pending_analysis?: {
        unprocessed_count: number;
        next_window: { start: string } | null;
      };
    };
    expect(detail.pending_analysis?.unprocessed_count).toBe(4);
    expect(detail.pending_analysis?.next_window?.start).toBe(failedStart.toISOString());

    const claimed = await claim();
    expect(claimed.run_id).not.toBe(failedRunId);
    expect(claimed.run_id).not.toBe(newerFailedRunId);
    expect(claimed.context.window_start).toBe(failedStart.toISOString());
    expect(claimed.context.content.map((row) => row.id)).toContain(event.id);
    const [run] = await sql`
      SELECT status, claimed_by, approved_input->>'agent_id' AS agent_id
      FROM runs WHERE id = ${claimed.run_id}
    `;
    expect(run).toMatchObject({ status: 'running', agent_id: agentId });
    expect(String(run.claimed_by)).toContain(userId);
    const [supersededRun] = await sql`
      SELECT status, outcome, error_message FROM runs WHERE id = ${superseded.runId}
    `;
    expect(supersededRun).toMatchObject({
      status: 'cancelled',
      outcome: 'infra_error',
      error_message: 'Superseded by the oldest recoverable Automation window',
    });
  });

  it('allows only one PostgreSQL-mediated claimant for a logical window', async () => {
    const settled = await Promise.allSettled([claim(), claim()]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await sql`
      SELECT id FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND status = 'running'
    `;
    expect(active).toHaveLength(1);
  });

  it('reclaims an expired lease, fences the stale run, and replays a committed completion', async () => {
    const stale = await claim();
    await sql`UPDATE runs SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${stale.run_id}`;

    const current = await claim();
    expect(current.run_id).not.toBe(stale.run_id);
    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: stale.run_id,
        window_token: stale.context.window_token,
        extracted_data: { signals: [] },
      })
    ).rejects.toThrow(/run|lease|terminal|fenced/i);

    const input = {
      automation_id: String(automationId),
      run_id: current.run_id,
      window_token: current.context.window_token,
      extracted_data: { signals: [] },
    };
    const completed = (await api.automations.completeWindow(input)) as {
      run_id: number;
      completed_now: boolean;
    };
    expect(completed).toMatchObject({ run_id: current.run_id, completed_now: true });

    await sql`UPDATE runs SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${current.run_id}`;
    const replay = (await api.automations.completeWindow(input)) as {
      run_id: number;
      completed_now: boolean;
    };
    expect(replay).toMatchObject({ run_id: current.run_id, completed_now: false });
  });

  it('requires every bounded source page before completing the logical window', async () => {
    const start = dayStart(1);
    for (let index = 0; index < 3; index++) {
      await createTestEvent({
        entity_id: entityId,
        organization_id: orgId,
        content: `Paged source ${index}`,
        occurred_at: new Date(start.getTime() + (index + 1) * 3_600_000),
      });
    }

    const first = await claim({ limit: 2 });
    expect(first.context.page.has_more).toBe(true);
    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: first.run_id,
        window_token: first.context.window_token,
        extracted_data: { signals: [] },
      })
    ).rejects.toThrow(/More Automation source pages remain/);
    const [afterPartialPage] = await sql`
      SELECT a.next_window_start, r.status
      FROM automations a
      JOIN runs r ON r.id = ${first.run_id}
      WHERE a.id = ${automationId}
    `;
    expect(new Date(afterPartialPage.next_window_start).toISOString()).toBe(
      first.context.window_start
    );
    expect(afterPartialPage.status).toBe('running');

    const cursor = first.context.page.next_cursor;
    expect(cursor).toBeDefined();
    const second = await claim({
      run_id: first.run_id,
      limit: 2,
      before_occurred_at: cursor?.occurred_at,
      before_id: cursor?.id,
    });
    expect(second.run_id).toBe(first.run_id);
    expect(second.context.page.has_more).toBe(false);

    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: first.run_id,
        window_tokens: [first.context.window_token, second.context.window_token],
        extracted_data: { signals: [] },
      })
    ).resolves.toMatchObject({ completed_now: true, content_linked: 3 });
  });

  it('fails closed when a non-pageable auxiliary source is truncated', async () => {
    for (let index = 0; index < 3; index++) {
      await createTestEntity({
        name: `Auxiliary context ${index}`,
        organization_id: orgId,
        created_by: userId,
      });
    }
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'truncated-auxiliary-source',
      name: 'Truncated auxiliary source',
      prompt: 'Extract durable signals using {{content}} and {{context_rows}}.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
        {
          name: 'context_rows',
          query: 'SELECT id, name FROM entities WHERE deleted_at IS NULL ORDER BY id',
          context: true,
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      agent_id: agentId,
    })) as { automation_id: string };

    const truncated = (await api.automations.claimNextWindow({
      automation_id: created.automation_id,
      limit: 2,
    })) as ClaimResult;
    expect(truncated.context.sources_page?.context_rows).toEqual({
      returned: 2,
      limit: 2,
      has_more: true,
    });
    await expect(
      api.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: truncated.run_id,
        window_token: truncated.context.window_token,
        extracted_data: { signals: [] },
      })
    ).rejects.toThrow(/context_rows.*cannot be completed safely/);

    const [afterRejectedCompletion] = await sql`
      SELECT a.next_window_start, r.status
      FROM automations a
      JOIN runs r ON r.id = ${truncated.run_id}
      WHERE a.id = ${Number(created.automation_id)}
    `;
    expect(new Date(afterRejectedCompletion.next_window_start).toISOString()).toBe(
      truncated.context.window_start
    );
    expect(afterRejectedCompletion.status).toBe('running');
  });

  it('recovers a legacy hole before a later out-of-order completion on every claim surface', async () => {
    const completedStart = dayStart(5);
    const completedEnd = dayStart(4);
    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, outcome,
        approved_input, action_output, run_metadata, created_at, completed_at
      ) VALUES (
        ${orgId}, 'automation', ${automationId}, 'completed', 'scoreable',
        ${sql.json({
          granularity: 'daily',
          window_start: completedStart.toISOString(),
          window_end: new Date(completedEnd.getTime() - 1).toISOString(),
        })},
        ${sql.json({ signals: [] })}, ${sql.json({ content_analyzed: 0 })},
        ${completedEnd}, ${completedEnd}
      )
    `;

    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, outcome,
        approved_input, action_output, run_metadata, created_at, completed_at
      ) VALUES (
        ${orgId}, 'automation', ${automationId}, 'completed', 'scoreable',
        ${sql.json({
          granularity: 'daily',
          window_start: dayStart(2).toISOString(),
          window_end: dayStart(1).toISOString(),
        })},
        ${sql.json({ signals: [] })}, ${sql.json({ content_analyzed: 0 })},
        ${dayStart(1)}, ${dayStart(1)}
      )
    `;

    const pending = await computePendingWindow(sql, automationId, 'daily');
    expect(pending.windowStart.toISOString()).toBe(completedEnd.toISOString());

    const detail = (await api.automations.get({
      automation_id: String(automationId),
    })) as {
      pending_analysis?: {
        unprocessed_count: number;
        next_window: { start: string } | null;
      };
      gaps?: Array<{ start: string; end: string }>;
    };
    expect(detail.pending_analysis?.unprocessed_count).toBe(3);
    expect(detail.pending_analysis?.next_window?.start).toBe(completedEnd.toISOString());
    expect(detail.gaps).toContainEqual({
      start: completedEnd.toISOString(),
      end: dayStart(2).toISOString(),
    });
    expect(detail.gaps).toContainEqual({
      start: dayStart(1).toISOString(),
      end: dayStart(0).toISOString(),
    });
    expect(detail.gaps).not.toContainEqual({
      start: new Date(completedEnd.getTime() - 1).toISOString(),
      end: completedEnd.toISOString(),
    });

    const claimed = await claim();
    expect(claimed.context.window_start).toBe(completedEnd.toISOString());
    const [automation] = await sql`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(automation.next_window_start).toISOString()).toBe(completedEnd.toISOString());
  });

  it('completes empty source windows and keeps output/reaction execution idempotent', async () => {
    await api.automations.setReactionScript({
      automation_id: String(automationId),
      reaction_script: 'export default async function reaction() { return; }',
    });
    const empty = await claim();
    expect(empty.context.content).toEqual([]);

    const completionInput = {
      automation_id: String(automationId),
      run_id: empty.run_id,
      window_token: empty.context.window_token,
      extracted_data: {
        signals: [{ content: 'One durable signal', idempotency_key: 'stable-signal' }],
      },
    };
    const first = (await api.automations.completeWindow(completionInput)) as {
      completed_now: boolean;
    };
    expect(first.completed_now).toBe(true);
    const outputCountAfterFirst = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM events
      WHERE organization_id = ${orgId}
        AND automation_id = ${automationId}
        AND semantic_type = 'observation'
    `;
    const reactionCountAfterFirst = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM automation_reactions
      WHERE source_run_id = ${empty.run_id}
    `;

    const replay = (await api.automations.completeWindow(completionInput)) as {
      completed_now: boolean;
    };
    expect(replay.completed_now).toBe(false);
    const outputCountAfterReplay = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM events
      WHERE organization_id = ${orgId}
        AND automation_id = ${automationId}
        AND semantic_type = 'observation'
    `;
    const reactionCountAfterReplay = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM automation_reactions
      WHERE source_run_id = ${empty.run_id}
    `;
    expect(Number(outputCountAfterFirst[0].count)).toBe(1);
    expect(outputCountAfterReplay).toEqual(outputCountAfterFirst);
    expect(reactionCountAfterReplay).toEqual(reactionCountAfterFirst);
  });
});
