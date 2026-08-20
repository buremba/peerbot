/** Scheduled Automation period rollover from completed run timestamps. */

import { afterEach, describe, expect, it } from 'vitest';
import { computePendingWindow, nextAutomationWindowStart } from '../window-utils';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { createAutomationRun } from '../../runs/queue-service';

/** Insert a completed result run covering [start, end). */
async function seedWindow(opts: {
  orgId: string;
  userId: string;
  automationId: number;
  granularity: string;
  start: string;
  end: string;
}): Promise<void> {
  const sql = getTestDb();
  const agent = await createTestAgent({
    organizationId: opts.orgId,
    ownerUserId: opts.userId,
  });
  await sql`
    INSERT INTO automations (
      id, name, slug, created_by, organization_id, agent_id, automation_group_id
    ) VALUES (
      ${opts.automationId}, ${`Window ${opts.automationId}`},
      ${`window-${opts.automationId}`}, ${opts.userId}, ${opts.orgId},
      ${agent.agentId}, ${opts.automationId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  const run = await createAutomationRun({
    organizationId: opts.orgId,
    automationId: opts.automationId,
    agentId: agent.agentId,
    windowStart: opts.start,
    windowEnd: opts.end,
    dispatchSource: 'scheduled',
  });
  await sql`
    UPDATE runs SET status = 'completed', completed_at = ${opts.end},
      action_output = '{}'::jsonb,
      approved_input = approved_input || ${sql.json({ granularity: opts.granularity })}::jsonb
    WHERE id = ${run.runId}
  `;
}

async function seedOrg() {
  await cleanupTestDatabase();
  const org = await createTestOrganization({ name: 'Window Org' });
  const user = await createTestUser({ email: 'window@test.example.com' });
  return { orgId: org.id, userId: user.id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day `offsetDays` back from now. */
const dayStart = (offsetDays: number): Date => {
  const d = new Date(Date.now() - offsetDays * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** Start of the Monday `offsetWeeks` back from the current week. */
const weekStart = (offsetWeeks: number): Date => {
  const d = new Date(Date.now() - offsetWeeks * 7 * DAY_MS);
  const dayOfWeek = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

describe('computePendingWindow', () => {
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  // The Automation 71 failure, reduced. A daily window closed with an INCLUSIVE
  // end must still roll the period forward to the next midnight.
  it('rolls forward to the next aligned period after an inclusive-end window', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9001;
    const previous = dayStart(2);
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'daily',
      start: previous.toISOString(),
      end: new Date(previous.getTime() + DAY_MS - 1).toISOString(), // inclusive convention
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'daily'
    );

    // The NEXT day at midnight — not 23:59:59.999, and not the seeded day again.
    expect(windowStart.toISOString()).toBe(dayStart(1).toISOString());
    expect(windowEnd.toISOString()).toBe(dayStart(0).toISOString());
  });

  it('rolls forward identically when the previous end was exclusive', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9002;
    const previous = dayStart(2);
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'daily',
      start: previous.toISOString(),
      end: dayStart(1).toISOString(), // exclusive convention
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe(dayStart(1).toISOString());
    expect(windowEnd.toISOString()).toBe(dayStart(0).toISOString());
  });

  // Self-heal: the 14 already-misaligned prod rows must recover on their own,
  // without a data migration rewriting window identities. The corrupt start is a
  // period boundary minus a millisecond, exactly as prod stores it — chaining off
  // it unaligned would carry the `23:59:59.999` into the next window forever.
  it('recovers from an already-misaligned stored window', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9003;
    const corruptStart = new Date(dayStart(2).getTime() + DAY_MS - 1);
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'daily',
      start: corruptStart.toISOString(),
      end: new Date(dayStart(1).getTime() + DAY_MS - 1).toISOString(),
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe(dayStart(1).toISOString());
    expect(windowEnd.toISOString()).toBe(dayStart(0).toISOString());
    expect(windowStart.getUTCHours()).toBe(0);
  });

  // Gap 2. No window may ever be shorter than its granularity — that is what
  // produced five 0-second windows with content_analyzed = 0.
  it('never produces a degenerate window, whatever the stored boundary', async () => {
    const { orgId, userId } = await seedOrg();
    const cases = [
      { id: 9101, start: '2026-07-23T23:59:59.999Z', end: '2026-07-24T00:00:00.000Z' },
      { id: 9102, start: '2026-07-24T23:59:59.999Z', end: '2026-07-25T00:00:00.000Z' },
      { id: 9103, start: '2026-07-25T00:00:00.000Z', end: '2026-07-25T23:59:59.999Z' },
    ];
    for (const c of cases) {
      await seedWindow({
        orgId,
        userId,
        automationId: c.id,
        granularity: 'daily',
        start: c.start,
        end: c.end,
      });
    }

    for (const c of cases) {
      const { windowStart, windowEnd } = await computePendingWindow(
        getTestDb(),
        c.id,
        'daily'
      );
      const duration = windowEnd.getTime() - windowStart.getTime();
      expect(duration, `automation ${c.id} window duration`).toBe(DAY_MS);
      expect(windowStart.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    }
  });

  // The other direction. An hourly cron gets a DAILY window (there is no hourly
  // granularity), so every run inside the same day must resolve to the SAME
  // period rather than minting future periods for later runs that day.
  it('re-dispatches the CURRENT period rather than minting a future one', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9004;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const tomorrowIso = new Date(today.getTime() + DAY_MS).toISOString();

    // Today's window is already complete — the state after the first run of the day.
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'daily',
      start: todayIso,
      end: tomorrowIso,
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'daily'
    );

    // Still today. Advancing here would mint tomorrow's window before tomorrow.
    expect(windowStart.toISOString()).toBe(todayIso);
    expect(windowEnd.toISOString()).toBe(tomorrowIso);
  });

  // The contract this branch changed. Walking forward one period per run never
  // closed a gap — the clock advances a period per period too — so prod Automation 2
  // sat 50 days behind for weeks. An Automation months behind is now dispatched the
  // period that just closed, and catches up in a single run.
  it('jumps to the current period when far behind, not one period per run', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9005;
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'daily',
      start: '2026-01-10T00:00:00.000Z',
      end: '2026-01-11T00:00:00.000Z',
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe(dayStart(1).toISOString());
    expect(windowEnd.toISOString()).toBe(dayStart(0).toISOString());
    expect(windowStart.toISOString()).not.toBe('2026-01-11T00:00:00.000Z');
  });

  it('aligns weekly windows to the week boundary', async () => {
    const { orgId, userId } = await seedOrg();
    const automationId = 9006;
    const previousWeek = weekStart(2);
    await seedWindow({
      orgId,
      userId,
      automationId,
      granularity: 'weekly',
      start: previousWeek.toISOString(), // a Monday
      end: new Date(previousWeek.getTime() + 7 * DAY_MS - 1).toISOString(), // inclusive, as stored on prod
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      automationId,
      'weekly'
    );

    expect(windowStart.toISOString()).toBe(weekStart(1).toISOString());
    expect(windowEnd.toISOString()).toBe(weekStart(0).toISOString());
    expect(windowStart.getUTCDay()).toBe(1); // Monday
  });

  it('starts from an aligned period when the Automation has no windows yet', async () => {
    await seedOrg();

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      9007,
      'daily'
    );

    expect(windowStart.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    expect(windowEnd.getTime() - windowStart.getTime()).toBe(DAY_MS);
  });
});

/**
 * The rule itself, at a fixed instant and with no database.
 *
 * `get_automation`'s `next_window` PREVIEWS what `computePendingWindow`
 * dispatches. While those were two implementations they drifted — the preview
 * chained off `window_end` and the dispatcher off `window_start`, a full period
 * apart on a legacy row with an inclusive end, so the agent was shown one
 * window and the run was handed another. They now share this function, and
 * these cases pin the shared contract rather than either caller.
 */
describe('nextAutomationWindowStart', () => {
  const NOW = new Date('2026-07-31T17:26:00.000Z');

  it('advances one aligned period from the previous start', () => {
    expect(
      nextAutomationWindowStart(new Date('2026-07-30T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-07-31T00:00:00.000Z');
  });

  // Both boundary conventions, and a corrupt start, must land on the same period.
  it.each([
    ['aligned start', '2026-07-30T00:00:00.000Z'],
    ['inclusive-end-derived start', '2026-07-30T23:59:59.999Z'],
    ['mid-period start', '2026-07-30T11:17:03.221Z'],
  ])('normalises a %s to the same next period', (_label, stored) => {
    expect(nextAutomationWindowStart(new Date(stored), NOW, 'daily').toISOString()).toBe(
      '2026-07-31T00:00:00.000Z'
    );
  });

  it('caps at the current period instead of minting a future one', () => {
    // Today is already done — a sub-daily cron must get today again, not tomorrow.
    expect(
      nextAutomationWindowStart(new Date('2026-07-31T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-07-31T00:00:00.000Z');
  });

  // The floor. Chaining alone returns 2026-01-11 here and needs one successful run
  // per missed day to reach the present, so a gap freezes instead of closing —
  // prod Automation 2 sat 50 days behind on exactly this. Never older than one period.
  it('jumps to the previous period when far behind, not one period at a time', () => {
    expect(
      nextAutomationWindowStart(new Date('2026-01-10T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-07-30T00:00:00.000Z');
  });

  it('starts one aligned period back when there is no previous window', () => {
    expect(nextAutomationWindowStart(null, NOW, 'daily').toISOString()).toBe(
      '2026-07-30T00:00:00.000Z'
    );
  });

  // Chaining a weekly Automation lands on a Monday...
  it('aligns weekly to Monday', () => {
    const out = nextAutomationWindowStart(new Date('2026-07-19T23:59:59.999Z'), NOW, 'weekly');
    expect(out.getUTCDay()).toBe(1);
    expect(out.toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });

  // ...and so does the floor, which is a separate code path and could have landed
  // mid-week by subtracting seven days from an unaligned instant.
  it('floors weekly to a Monday too', () => {
    const out = nextAutomationWindowStart(new Date('2026-06-28T23:59:59.999Z'), NOW, 'weekly');
    expect(out.getUTCDay()).toBe(1);
    expect(out.toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });
});
