/**
 * Window rollover for scheduled Behaviors.
 *
 * `canvas_windows` is a VIEW over `canvas_state` event chains: one row per chain
 * ROOT, content from the chain HEAD. The ROOT carries the period. So "did the
 * window roll over" is really "did a new root get created", and the only thing
 * that decides it is the (window_start, granularity) pair the run is dispatched
 * with — `findCanvasHead` matches on it, and a match means supersede-in-place
 * instead of a new period.
 *
 * The bug this pins: `computePendingWindow` chained the next window off the
 * previous window's `window_end`. That is only correct if `window_end` is an
 * EXCLUSIVE boundary, and prod stores both conventions in one table (measured
 * 2026-07-31: daily 29 inclusive `23:59:59.999` vs 32 exclusive `00:00:00`;
 * weekly 28 vs 2). Chaining off an inclusive end starts the next window at
 * `…T23:59:59.999Z` — a day minus a millisecond off — and 14 of 102 prod
 * windows are misaligned that way.
 *
 * Two distinct failures fall out, both silent:
 *
 *  1. The `windowEnd > currentPeriodEnd` clamp collapses a misaligned window to
 *     ZERO duration (`23:59:59.999` → `00:00:00`). Five such windows exist on
 *     prod and all five have `content_analyzed = 0` — a Behavior that analyzed
 *     nothing and reported success.
 *  2. The misaligned start never matches a fresh period, so no new root is
 *     created, so `lastWindow` never advances, so the scheduler re-dispatches
 *     the same window forever. Behavior 71 ran hourly for a full day writing
 *     into the previous day's window (dispatched `2026-07-30T23:59:59.999Z`,
 *     wrote `2026-07-30T00:00:00.000Z`).
 *
 * The fix must ALSO not run away in the other direction: granularity has no
 * 'hourly' (`BEHAVIOR_TIME_GRANULARITIES` is daily/weekly/monthly/quarterly),
 * so an hourly cron necessarily gets a DAILY window and must re-dispatch the
 * SAME period all day. "Always advance one period" would mint tomorrow's window
 * at 00:01 and march into the future.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { computePendingWindow, nextBehaviorWindowStart } from '../window-utils';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { createTestOrganization, createTestUser } from '../../__tests__/setup/test-fixtures';

/**
 * Insert a canvas ROOT event for `behaviorId` covering [start, end).
 *
 * Written as a raw `canvas_state` event because that is what a window IS — the
 * view derives from it. `end` is caller-supplied precisely so both boundary
 * conventions can be exercised.
 */
async function seedWindow(opts: {
  orgId: string;
  userId: string;
  behaviorId: number;
  granularity: string;
  start: string;
  end: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO events (
      organization_id, origin_id, semantic_type, payload_type, payload_data,
      occurred_at, created_by, metadata
    ) VALUES (
      ${opts.orgId}, ${`canvas_${opts.behaviorId}_${opts.start}`}, 'canvas_state',
      'json_template', ${sql.json({ items: [] } as never)},
      ${opts.end}, ${opts.userId},
      ${sql.json({
        behavior_id: opts.behaviorId,
        granularity: opts.granularity,
        window_start: opts.start,
        window_end: opts.end,
        content_analyzed: 0,
      } as never)}
    )
  `;
}

async function seedOrg() {
  await cleanupTestDatabase();
  const org = await createTestOrganization({ name: 'Window Org' });
  const user = await createTestUser({ email: 'window@test.example.com' });
  return { orgId: org.id, userId: user.id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('computePendingWindow', () => {
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  // The behaviour-71 failure, reduced. A daily window closed with an INCLUSIVE
  // end must still roll the period forward to the next midnight.
  it('rolls forward to the next aligned period after an inclusive-end window', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9001;
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'daily',
      start: '2026-07-30T00:00:00.000Z',
      end: '2026-07-30T23:59:59.999Z', // inclusive convention
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'daily'
    );

    // Must be the NEXT day at midnight — not 23:59:59.999, and not 7/30 again.
    expect(windowStart.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rolls forward identically when the previous end was exclusive', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9002;
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'daily',
      start: '2026-07-30T00:00:00.000Z',
      end: '2026-07-31T00:00:00.000Z', // exclusive convention
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  // Self-heal: the 14 already-misaligned prod rows must recover on their own,
  // without a data migration rewriting window identities.
  it('recovers from an already-misaligned stored window', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9003;
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'daily',
      start: '2026-07-29T23:59:59.999Z', // corrupt start, as found on prod
      end: '2026-07-30T23:59:59.999Z',
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-07-31T00:00:00.000Z');
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
        behaviorId: c.id,
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
      expect(duration, `behavior ${c.id} window duration`).toBe(DAY_MS);
      expect(windowStart.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    }
  });

  // The other direction. An hourly cron gets a DAILY window (there is no hourly
  // granularity), so every run inside the same day must resolve to the SAME
  // period — otherwise `replace_existing` can't refresh today's digest and the
  // Behavior mints future windows instead.
  it('re-dispatches the CURRENT period rather than minting a future one', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9004;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const tomorrowIso = new Date(today.getTime() + DAY_MS).toISOString();

    // Today's window is already complete — the state after the first run of the day.
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'daily',
      start: todayIso,
      end: tomorrowIso,
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'daily'
    );

    // Still today. Advancing here would mint tomorrow's window before tomorrow.
    expect(windowStart.toISOString()).toBe(todayIso);
    expect(windowEnd.toISOString()).toBe(tomorrowIso);
  });

  // Backfill must still walk forward one period at a time when genuinely behind.
  it('catches up one period per run when behind', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9005;
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'daily',
      start: '2026-01-10T00:00:00.000Z',
      end: '2026-01-11T00:00:00.000Z',
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'daily'
    );

    expect(windowStart.toISOString()).toBe('2026-01-11T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-01-12T00:00:00.000Z');
  });

  it('aligns weekly windows to the week boundary', async () => {
    const { orgId, userId } = await seedOrg();
    const behaviorId = 9006;
    await seedWindow({
      orgId,
      userId,
      behaviorId,
      granularity: 'weekly',
      start: '2026-06-22T00:00:00.000Z', // a Monday
      end: '2026-06-28T23:59:59.999Z', // inclusive, as stored on prod
    });

    const { windowStart, windowEnd } = await computePendingWindow(
      getTestDb(),
      behaviorId,
      'weekly'
    );

    expect(windowStart.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(windowStart.getUTCDay()).toBe(1); // Monday
  });

  it('starts from an aligned period when the Behavior has no windows yet', async () => {
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
 * `get_behavior`'s `next_window` PREVIEWS what `computePendingWindow`
 * dispatches. While those were two implementations they drifted — the preview
 * chained off `window_end` and the dispatcher off `window_start`, a full period
 * apart on a legacy row with an inclusive end, so the agent was shown one
 * window and the run was handed another. They now share this function, and
 * these cases pin the shared contract rather than either caller.
 */
describe('nextBehaviorWindowStart', () => {
  const NOW = new Date('2026-07-31T17:26:00.000Z');

  it('advances one aligned period from the previous start', () => {
    expect(
      nextBehaviorWindowStart(new Date('2026-07-30T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-07-31T00:00:00.000Z');
  });

  // Both boundary conventions, and a corrupt start, must land on the same period.
  it.each([
    ['aligned start', '2026-07-30T00:00:00.000Z'],
    ['inclusive-end-derived start', '2026-07-30T23:59:59.999Z'],
    ['mid-period start', '2026-07-30T11:17:03.221Z'],
  ])('normalises a %s to the same next period', (_label, stored) => {
    expect(nextBehaviorWindowStart(new Date(stored), NOW, 'daily').toISOString()).toBe(
      '2026-07-31T00:00:00.000Z'
    );
  });

  it('caps at the current period instead of minting a future one', () => {
    // Today is already done — a sub-daily cron must get today again, not tomorrow.
    expect(
      nextBehaviorWindowStart(new Date('2026-07-31T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-07-31T00:00:00.000Z');
  });

  it('still catches up one period at a time when far behind', () => {
    expect(
      nextBehaviorWindowStart(new Date('2026-01-10T00:00:00.000Z'), NOW, 'daily').toISOString()
    ).toBe('2026-01-11T00:00:00.000Z');
  });

  it('starts one aligned period back when there is no previous window', () => {
    expect(nextBehaviorWindowStart(null, NOW, 'daily').toISOString()).toBe(
      '2026-07-30T00:00:00.000Z'
    );
  });

  it('aligns weekly to Monday', () => {
    const out = nextBehaviorWindowStart(new Date('2026-06-28T23:59:59.999Z'), NOW, 'weekly');
    expect(out.getUTCDay()).toBe(1);
    expect(out.toISOString()).toBe('2026-06-29T00:00:00.000Z');
  });
});
