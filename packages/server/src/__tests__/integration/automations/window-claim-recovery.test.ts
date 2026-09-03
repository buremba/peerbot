import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthCacheForTests } from '../../../auth';
import { closeDbSingleton, type DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { runAutomationReactionTask } from '../../../automations/reaction-task';
import { createAutomationRun } from '../../../runs/queue-service';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import { handleClaimNextWindow } from '../../../tools/admin/manage_automations/claim-next-window';
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
import { SUPERSEDED_BY_ARRIVAL_MARK } from '../../../runs/run-outcome';

const ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const DAY_MS = 86_400_000;
let referenceNow = new Date();

function dayStart(daysAgo: number): Date {
  return new Date(referenceNow.getTime() - daysAgo * DAY_MS);
}

type ClaimContext = {
  content: Array<{ id: number }>;
  extraction_schema?: {
    properties?: Record<string, unknown>;
  };
  sources_page?: Record<string, { returned: number; limit: number; has_more: boolean }>;
  window_start: string;
  window_end: string;
  window_token: string;
  window_axis?: string;
  window_lag?: {
    last_window_start: string | null;
    unclaimed_from: string | null;
    unclaimed_to: string | null;
  };
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
    referenceNow = new Date();
    referenceNow.setUTCHours(0, 0, 0, 0);
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
      managed_agent_id: agentId,
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
    await sql`
      UPDATE automations
      SET next_window_start = ${failedStart.toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;
    const event = await createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: 'Source content from the failed range.',
      occurred_at: new Date(failedStart.getTime() + 3_600_000),
      // Stored inside the unclaimed range, which is what the window selects.
      created_at: new Date(failedStart.getTime() + 3_600_000),
    });

    const pending = await computePendingWindow(sql, automationId);
    expect(pending.windowStart.toISOString()).toBe(failedStart.toISOString());

    const detail = (await api.automations.get({
      automation_id: String(automationId),
    })) as {
      pending_analysis?: {
        unprocessed_content_count: number;
        next_window: { start: string } | null;
      };
    };
    // A failed run books nothing, so the mark still sits at its start and the
    // range a claim would hand out reaches from there to the horizon.
    expect(detail.pending_analysis?.next_window?.start).toBe(failedStart.toISOString());
    expect(detail.pending_analysis?.unprocessed_content_count).toBeGreaterThan(0);

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
      error_message: SUPERSEDED_BY_ARRIVAL_MARK,
    });
  });

  // The application is the SINGLE writer of the arrival mark. The two run-row
  // triggers that used to re-derive calendar coverage are dropped, so a run row
  // flipped to `completed` outside `complete_window` books nothing at all.
  //
  // This is the structural evidence for that claim, not a nicety: if a trigger
  // ever comes back it will re-derive coverage from run history, which on this
  // axis is exactly the wrong thing — a range a run merely RECORDED is not a
  // range it read to the end.
  it('does not move the mark for a run row completed outside the completion handler', async () => {
    const staleMark = dayStart(4);
    await sql`
      UPDATE automations
      SET next_window_start = ${staleMark.toISOString()}::timestamptz,
          last_completed_window_start = NULL
      WHERE id = ${automationId}
    `;
    const laterRun = await createAutomationRun({
      organizationId: orgId,
      automationId,
      agentId,
      windowStart: dayStart(2).toISOString(),
      windowEnd: dayStart(1).toISOString(),
      dispatchSource: 'scheduled',
    });

    await sql`
      UPDATE runs
      SET status = 'completed', outcome = 'scoreable', action_output = '{}'::jsonb,
          completed_at = current_timestamp
      WHERE id = ${laterRun.runId}
    `;

    const [projection] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(projection.next_window_start).toISOString()).toBe(
      staleMark.toISOString()
    );
    expect(projection.last_completed_window_start).toBeNull();

    // And the claim still hands out the whole unclaimed range.
    expect((await computePendingWindow(sql, automationId)).windowStart.toISOString()).toBe(
      staleMark.toISOString()
    );
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

  it('rejects source-page cursors without their active run continuation', async () => {
    await expect(
      api.automations.claimNextWindow({
        automation_id: String(automationId),
        before_occurred_at: dayStart(1).toISOString(),
        before_id: 1,
      })
    ).rejects.toThrow('source-page cursors require run_id');
    await expect(
      api.automations.claimNextWindow({
        automation_id: String(automationId),
        run_id: 1,
        before_occurred_at: dayStart(1).toISOString(),
      })
    ).rejects.toThrow('before_occurred_at and before_id must be provided together');

    const active = await sql`
      SELECT id FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND status IN ('claimed', 'running')
    `;
    expect(active).toHaveLength(0);
  });

  it('fences continuations to the full identified caller and rejects unidentified claimants', async () => {
    const first = await handleClaimNextWindow(
      { action: 'claim_next_window', automation_id: String(automationId) },
      ENV,
      { ...ctx, mcpSessionId: 'session-a' }
    );

    await expect(
      handleClaimNextWindow(
        {
          action: 'claim_next_window',
          automation_id: String(automationId),
          run_id: first.run_id,
        },
        ENV,
        { ...ctx, mcpSessionId: 'session-b' }
      )
    ).rejects.toThrow('Automation window continuation does not own an active lease.');

    await expect(
      handleClaimNextWindow(
        { action: 'claim_next_window', automation_id: String(automationId) },
        ENV,
        {
          ...ctx,
          userId: null,
          agentId: null,
          clientId: null,
          mcpSessionId: null,
        }
      )
    ).rejects.toThrow('claim_next_window requires an identified caller');
  });

  it('loads claimed source context with a one-connection database pool', async () => {
    const previousPoolMax = process.env.DB_POOL_MAX;
    await closeDbSingleton();
    clearAuthCacheForTests();
    process.env.DB_POOL_MAX = '1';
    try {
      const claimed = (await manageAutomations(
        {
          action: 'claim_next_window',
          automation_id: String(automationId),
          limit: 2,
        },
        ENV,
        ctx
      )) as ClaimResult;
      // The point of this test is that the claim completes at all on a
      // single-connection pool — the nested lock in `computePendingWindow` has
      // deadlocked here before. The window starts at the live mark (a claim
      // reads it, it does not move it) and reaches the horizon.
      const [automation] = await sql`
        SELECT next_window_start FROM automations WHERE id = ${automationId}
      `;
      expect(claimed.context.window_start).toBe(
        new Date(automation.next_window_start as string).toISOString()
      );
      expect(
        new Date(claimed.context.window_end).getTime()
      ).toBeGreaterThan(new Date(claimed.context.window_start).getTime());
    } finally {
      await closeDbSingleton();
      clearAuthCacheForTests();
      if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = previousPoolMax;
    }
  });

  it('uses the pending run version snapshot after an Automation edit', async () => {
    // Queued at the live mark, so the claim ADOPTS this pending run rather than
    // cancelling it — that adoption is what carries the version snapshot
    // forward past the edit below.
    const [before] = await sql<{ next_window_start: string | Date }>`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    const markBefore = new Date(before.next_window_start);
    const pending = await createAutomationRun({
      organizationId: orgId,
      automationId,
      agentId,
      windowStart: markBefore.toISOString(),
      windowEnd: new Date(markBefore.getTime() + DAY_MS).toISOString(),
      dispatchSource: 'scheduled',
    });
    const [snapshot] = await sql<{ version_id: number | string }>`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs WHERE id = ${pending.runId}
    `;

    await api.automations.createVersion({
      automation_id: String(automationId),
      prompt: 'Extract a different contract from future periods.',
      outputs: { findings: { event: 'observation' } },
      change_notes: 'change schema after the pending run was created',
    });
    const [edited] = await sql<{ current_version_id: number | string }>`
      SELECT current_version_id FROM automations WHERE id = ${automationId}
    `;
    expect(Number(edited.current_version_id)).not.toBe(Number(snapshot.version_id));

    const claimed = await claim();
    expect(claimed.run_id).toBe(pending.runId);
    expect(claimed.context.window_axis).toBe('created_at');
    expect(claimed.context.extraction_schema?.properties).toHaveProperty('signals');
    expect(claimed.context.extraction_schema?.properties).not.toHaveProperty('findings');
    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: claimed.run_id,
        window_token: claimed.context.window_token,
        extracted_data: { signals: [] },
      })
    ).resolves.toMatchObject({ completed_now: true });
  });

  // A cadence change used to reset the whole cursor, because the stored coverage
  // was expressed in calendar periods the new cadence no longer had. The arrival
  // mark is schedule-independent, so an in-flight claim survives the edit and its
  // completion books exactly the range it read.
  it('books an in-flight claim normally across a cadence change', async () => {
    const claimed = await claim();

    await api.automations.update({
      automation_id: String(automationId),
      triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }],
    });
    const [afterEdit] = await sql<{ next_window_start: string | Date }>`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    // The edit left the mark exactly where the claim found it.
    expect(new Date(afterEdit.next_window_start).toISOString()).toBe(
      claimed.context.window_start
    );

    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: claimed.run_id,
        window_token: claimed.context.window_token,
        extracted_data: { signals: [] },
      })
    ).resolves.toMatchObject({ completed_now: true });

    const [afterCompletion] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(afterCompletion.next_window_start).toISOString()).toBe(
      claimed.context.window_end
    );
    expect(
      new Date(afterCompletion.last_completed_window_start as string).toISOString()
    ).toBe(claimed.context.window_start);
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
    ).rejects.toThrow('window_token does not own the current Automation lease.');

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
    expect(second.lease_expires_at).not.toBe(first.lease_expires_at);

    const refreshedSecond = await claim({
      run_id: first.run_id,
      limit: 2,
      before_occurred_at: cursor?.occurred_at,
      before_id: cursor?.id,
    });
    expect(refreshedSecond.lease_expires_at).not.toBe(second.lease_expires_at);

    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: first.run_id,
        window_tokens: [first.context.window_token, second.context.window_token],
        extracted_data: { signals: [] },
      })
    ).rejects.toThrow('window_token does not own the current Automation lease.');

    await expect(
      api.automations.completeWindow({
        automation_id: String(automationId),
        run_id: first.run_id,
        window_tokens: [first.context.window_token, refreshedSecond.context.window_token],
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
      managed_agent_id: agentId,
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

  it('fails closed when a truncated non-event source is named content', async () => {
    for (let index = 0; index < 3; index++) {
      await createTestEntity({
        name: `Named content context ${index}`,
        organization_id: orgId,
        created_by: userId,
      });
    }
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'named-content-context-source',
      name: 'Named content context source',
      prompt: 'Extract durable signals from {{primary}} using {{content}}.',
      sources: [
        {
          name: 'primary',
          query:
            "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
        {
          name: 'content',
          query: 'SELECT id, name FROM entities WHERE deleted_at IS NULL ORDER BY id',
          context: true,
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const truncated = (await api.automations.claimNextWindow({
      automation_id: created.automation_id,
      limit: 2,
    })) as ClaimResult;
    expect(truncated.context.sources_page?.content?.has_more).toBe(true);
    await expect(
      api.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: truncated.run_id,
        window_token: truncated.context.window_token,
        extracted_data: { signals: [] },
      })
    ).rejects.toThrow(/content.*cannot be completed safely/);
  });

  // Coverage on the arrival axis is ONE contiguous range, so there are no holes
  // to recover and no gap list to report. What replaces that machinery is the
  // rule that keeps it contiguous: a completion whose range starts AFTER the
  // mark books nothing, so it can never leave a hole behind it in the first
  // place. The same answer has to come back whatever presentation filters the
  // caller passes, since those page the window HISTORY, not the pending state.
  it('never opens a hole, and reports the same pending state under every presentation filter', async () => {
    const staleMark = dayStart(4);
    await sql`
      UPDATE automations
      SET next_window_start = ${staleMark.toISOString()}::timestamptz,
          last_completed_window_start = NULL
      WHERE id = ${automationId}
    `;

    // A completed run for a LATER range, exactly as an out-of-order backfill
    // leaves one behind.
    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, outcome,
        approved_input, action_output, run_metadata, created_at, completed_at
      ) VALUES (
        ${orgId}, 'automation', ${automationId}, 'completed', 'scoreable',
        ${sql.json({
          window_start: dayStart(2).toISOString(),
          window_end: dayStart(1).toISOString(),
        })},
        ${sql.json({ signals: [] })}, ${sql.json({ content_analyzed: 0 })},
        ${dayStart(1)}, ${dayStart(1)}
      )
    `;

    const pending = await computePendingWindow(sql, automationId);
    expect(pending.windowStart.toISOString()).toBe(staleMark.toISOString());

    type PendingDetail = {
      pending_analysis?: {
        unprocessed_content_count: number;
        next_window: { start: string; end: string } | null;
      };
    };
    const detail = (await api.automations.get({
      automation_id: String(automationId),
    })) as PendingDetail;
    expect(detail.pending_analysis?.next_window?.start).toBe(staleMark.toISOString());

    const expectedGlobalDiagnostics = {
      unprocessed_content_count: detail.pending_analysis?.unprocessed_content_count,
      next_window_start: detail.pending_analysis?.next_window?.start,
    };
    for (const presentationFilters of [
      { page: 2, page_size: 1 },
      { page_size: 1 },
      { content_since: dayStart(2).toISOString() },
      { content_until: dayStart(3).toISOString() },
      {
        content_since: dayStart(3).toISOString(),
        content_until: dayStart(1).toISOString(),
      },
    ]) {
      const filtered = (await api.automations.get({
        automation_id: String(automationId),
        ...presentationFilters,
      })) as PendingDetail;
      expect({
        unprocessed_content_count: filtered.pending_analysis?.unprocessed_content_count,
        next_window_start: filtered.pending_analysis?.next_window?.start,
      }).toEqual(expectedGlobalDiagnostics);
    }

    const claimed = await claim();
    expect(claimed.context.window_start).toBe(staleMark.toISOString());
    const [automation] = await sql`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(automation.next_window_start).toISOString()).toBe(
      staleMark.toISOString()
    );
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
      reaction_task_run_id?: number;
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

    // The reaction is a durable task now, so drive it the way the scheduler
    // would; the invariant under test is unchanged — a replayed completion must
    // not produce a second execution.
    await runAutomationReactionTask(
      { organizationId: orgId, automationId, sourceRunId: empty.run_id },
      {} as Env,
      Number(first.reaction_task_run_id)
    );
    const reactionCountAfterTask = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM automation_reactions
      WHERE source_run_id = ${empty.run_id}
    `;
    expect(Number(reactionCountAfterTask[0].count)).toBe(1);

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
    // Zero BEFORE the task runs: completion commits the handoff, it no longer
    // executes the script inline.
    expect(Number(reactionCountAfterFirst[0].count)).toBe(0);
    expect(outputCountAfterReplay).toEqual(outputCountAfterFirst);
    // Still exactly one execution after the replay — the replay queued nothing.
    expect(Number(reactionCountAfterReplay[0].count)).toBe(1);
  });
});
