/**
 * The two Automation arrival knobs accept ZERO as a legal value, which means
 * they cannot reuse `parseEnvInt` (it rejects zero via `> 0`) and must instead
 * reject an empty string explicitly — `Number('')` is `0`, and `0 >= 0` passes.
 *
 * A bare `AUTOMATION_ARRIVAL_SETTLE_MS=` in a .env is a shape people write
 * meaning "unset". Read as zero it collapses the arrival horizon to the raw
 * database clock and reopens the commit-visibility race the settle window
 * exists to close — silently, in production, with nothing in a log to say so.
 * The lookback has the same shape: read as zero, a new Automation is born blind
 * to everything already ingested.
 *
 * Both defects shipped in this file's first draft and were caught in review.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { intervals } from '../intervals';

const SETTLE = 'AUTOMATION_ARRIVAL_SETTLE_MS';
const LOOKBACK = 'AUTOMATION_FIRST_WINDOW_LOOKBACK_MS';
const DEFAULT_SETTLE_MS = 60_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const original = { settle: process.env[SETTLE], lookback: process.env[LOOKBACK] };

const set = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  set(SETTLE, original.settle);
  set(LOOKBACK, original.lookback);
});

describe('Automation arrival env knobs', () => {
  // The regression. Every one of these means "unset", and none may read as 0.
  it.each(['', '   ', '\t'])(
    'falls back to the default when the settle window is blank (%j)',
    (blank) => {
      set(SETTLE, blank);
      expect(intervals.automationArrivalSettleMs).toBe(DEFAULT_SETTLE_MS);
    }
  );

  it.each(['', '   ', '\t'])(
    'falls back to the default when the lookback is blank (%j)',
    (blank) => {
      set(LOOKBACK, blank);
      expect(intervals.automationFirstWindowLookbackMs).toBe(DEFAULT_LOOKBACK_MS);
    }
  );

  it('falls back when unset', () => {
    set(SETTLE, undefined);
    set(LOOKBACK, undefined);
    expect(intervals.automationArrivalSettleMs).toBe(DEFAULT_SETTLE_MS);
    expect(intervals.automationFirstWindowLookbackMs).toBe(DEFAULT_LOOKBACK_MS);
  });

  // Zero stays legal when it is asked for EXPLICITLY — the integration suites
  // depend on it to see a row they just inserted.
  it('honours an explicit zero', () => {
    set(SETTLE, '0');
    set(LOOKBACK, '0');
    expect(intervals.automationArrivalSettleMs).toBe(0);
    expect(intervals.automationFirstWindowLookbackMs).toBe(0);
  });

  it('reads a real value, rounded, and rejects junk and negatives', () => {
    set(SETTLE, '1500');
    expect(intervals.automationArrivalSettleMs).toBe(1500);
    set(SETTLE, '1500.6');
    expect(intervals.automationArrivalSettleMs).toBe(1501);
    for (const junk of ['abc', '-1', 'NaN', 'Infinity']) {
      set(SETTLE, junk);
      expect(intervals.automationArrivalSettleMs).toBe(DEFAULT_SETTLE_MS);
    }
  });
});
