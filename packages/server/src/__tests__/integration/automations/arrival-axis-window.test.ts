/**
 * Automation windows book progress on the ARRIVAL axis (`events.created_at`),
 * not on when things happened (`occurred_at`).
 *
 * Three properties, each of which the occurrence-axis design could not hold:
 *
 *  1. A row Lobu stored late (a resync, an archive import, a calendar item
 *     written days after it began) is still delivered — it arrives after the
 *     mark, so the next run sees it. Under occurrence-axis windows the same row
 *     landed inside an already-completed period and was never read.
 *  2. A failed run's range is reclaimed: the mark only moves on completion.
 *  3. No range is handed out twice: a completed range moves the mark to its
 *     end, and the next claim starts exactly there.
 *
 * The frontier is `now() − AUTOMATION_ARRIVAL_SETTLE_MS`, read from the database
 * clock, so a row stored inside the settle window is never inside a handed-out
 * range while its writer could still be uncommitted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { automationArrivalSettleMs } from '../../../utils/window-utils';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEntity,
  createTestEvent,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type ClaimResult = {
  run_id: number;
  context: {
    content: Array<{ id: number }>;
    window_start: string;
    window_end: string;
    window_token: string;
  };
};

describe('Automation windows on the arrival axis', () => {
  let sql: DbClient;
  let orgId: string;
  let entityId: number;
  let automationId: number;
  let api: TestApiClient;

  // The rest of the suite runs with the settle window collapsed to zero so a
  // fixture row is claimable the instant it lands (`vitest.config.ts`). These
  // cases exist to prove the settle window itself, so they restore the
  // production budget — every row below is stamped relative to it.
  const suiteSettleMs = process.env.AUTOMATION_ARRIVAL_SETTLE_MS;

  beforeAll(async () => {
    process.env.AUTOMATION_ARRIVAL_SETTLE_MS = String(MINUTE_MS);
    await initWorkspaceProvider();
  });

  afterAll(() => {
    if (suiteSettleMs === undefined) delete process.env.AUTOMATION_ARRIVAL_SETTLE_MS;
    else process.env.AUTOMATION_ARRIVAL_SETTLE_MS = suiteSettleMs;
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    sql = getTestDb() as unknown as DbClient;
    orgId = seeded.org.id;
    const agent = await createTestAgent({
      organizationId: orgId,
      ownerUserId: seeded.user.id,
      agentId: 'arrival-axis-agent',
    });
    const entity = await createTestEntity({
      name: 'Arrival axis subject',
      organization_id: orgId,
      created_by: seeded.user.id,
    });
    entityId = entity.id;
    api = await TestApiClient.for({
      organizationId: orgId,
      userId: seeded.user.id,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'arrival-axis',
      name: 'Arrival axis',
      prompt: 'Summarise everything that arrived since the last run.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, created_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
  });

  async function setMark(mark: Date): Promise<void> {
    await sql`
      UPDATE automations
      SET next_window_start = ${mark.toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;
  }

  async function storedRow(input: { occurredAt: Date; createdAt: Date; text: string }) {
    return createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: input.text,
      occurred_at: input.occurredAt,
      created_at: input.createdAt,
    });
  }

  async function claim(): Promise<ClaimResult> {
    return (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as ClaimResult;
  }

  async function complete(claimed: ClaimResult): Promise<void> {
    await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    });
  }

  async function readProjection() {
    const [row] = await sql<{
      next_window_start: Date | string;
      coverage_lower: Date | string | null;
      coverage_upper: Date | string | null;
      coverage_ranges: number | string;
      last_completed_window_start: Date | string | null;
    }>`
      SELECT next_window_start,
             lower(completed_window_coverage) AS coverage_lower,
             upper(completed_window_coverage) AS coverage_upper,
             (SELECT count(*) FROM unnest(completed_window_coverage)) AS coverage_ranges,
             last_completed_window_start
      FROM automations
      WHERE id = ${automationId}
    `;
    return {
      mark: new Date(row.next_window_start).toISOString(),
      coverage:
        row.coverage_lower == null || row.coverage_upper == null
          ? null
          : {
              lower: new Date(row.coverage_lower).toISOString(),
              upper: new Date(row.coverage_upper).toISOString(),
              ranges: Number(row.coverage_ranges),
            },
      lastCompletedWindowStart:
        row.last_completed_window_start == null
          ? null
          : new Date(row.last_completed_window_start).toISOString(),
    };
  }

  it('delivers a row stored late even though it happened long before the window', async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);

    // Happened a month ago, stored five minutes ago: a resync or an import.
    const lateRow = await storedRow({
      occurredAt: new Date(now - 30 * DAY_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'stored late',
    });
    // Stored just now: inside the settle window, so it belongs to the NEXT run.
    const freshRow = await storedRow({
      occurredAt: new Date(now - 2 * MINUTE_MS),
      createdAt: new Date(now),
      text: 'stored within the settle window',
    });
    // Stored before the mark: already booked by an earlier run.
    const bookedRow = await storedRow({
      occurredAt: new Date(now - MINUTE_MS),
      createdAt: new Date(now - 20 * MINUTE_MS),
      text: 'stored before the mark',
    });

    const claimed = await claim();
    const ids = claimed.context.content.map((row) => row.id);
    expect(ids).toContain(lateRow.id);
    expect(ids).not.toContain(freshRow.id);
    expect(ids).not.toContain(bookedRow.id);

    expect(claimed.context.window_start).toBe(mark.toISOString());
    const windowEnd = new Date(claimed.context.window_end).getTime();
    expect(windowEnd).toBeLessThanOrEqual(Date.now() - automationArrivalSettleMs());
    expect(windowEnd).toBeGreaterThan(now - automationArrivalSettleMs() - 10_000);
  });

  it("reclaims a failed run's range instead of skipping it", async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);
    const row = await storedRow({
      occurredAt: new Date(now - 5 * MINUTE_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'seen by the failed run',
    });

    const first = await claim();
    expect(first.context.content.map((r) => r.id)).toContain(row.id);
    await sql`
      UPDATE runs
      SET status = 'failed', outcome = 'agent_error', completed_at = NOW(),
          error_message = 'simulated failure'
      WHERE id = ${first.run_id}
    `;
    expect((await readProjection()).mark).toBe(mark.toISOString());

    const second = await claim();
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.context.window_start).toBe(first.context.window_start);
    expect(new Date(second.context.window_end).getTime()).toBeGreaterThanOrEqual(
      new Date(first.context.window_end).getTime()
    );
    expect(second.context.content.map((r) => r.id)).toContain(row.id);
  });

  it('never hands out the same range twice', async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);
    const row = await storedRow({
      occurredAt: new Date(now - 5 * MINUTE_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'booked by the first run',
    });

    const first = await claim();
    expect(first.context.content.map((r) => r.id)).toContain(row.id);
    await complete(first);

    const projection = await readProjection();
    expect(projection.mark).toBe(first.context.window_end);
    // One contiguous range from the seed to the mark — never a set with gaps.
    expect(projection.coverage).toEqual({
      lower: mark.toISOString(),
      upper: first.context.window_end,
      ranges: 1,
    });
    expect(projection.lastCompletedWindowStart).toBe(first.context.window_start);

    const second = await claim();
    expect(second.context.window_start).toBe(first.context.window_end);
    expect(second.context.content.map((r) => r.id)).not.toContain(row.id);

    // Completing the second range keeps the coverage a single range.
    await complete(second);
    const after = await readProjection();
    expect(after.mark).toBe(second.context.window_end);
    expect(after.coverage).toEqual({
      lower: mark.toISOString(),
      upper: second.context.window_end,
      ranges: 1,
    });
  });
});

