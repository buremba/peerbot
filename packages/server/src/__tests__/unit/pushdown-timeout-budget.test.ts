/**
 * The pushdown budget policy, on its own.
 *
 * The wiring (a slow source actually being killed) is covered by the
 * integration suite; this pins the arithmetic, which is what silently regresses:
 * a caller deadline may only SHORTEN the budget, never lift the cap, and an
 * already-expired deadline must fail before anything is forked.
 */

import { describe, expect, it } from 'bun:test';
import {
  PUSHDOWN_QUERY_TIMEOUT_MS,
  resolvePushdownTimeoutMs,
} from '../../lib/connector-pushdown';

describe('resolvePushdownTimeoutMs', () => {
  it('caps a pushdown with no caller deadline', () => {
    expect(resolvePushdownTimeoutMs(undefined)).toBe(PUSHDOWN_QUERY_TIMEOUT_MS);
  });

  it('shortens to a nearer caller deadline', () => {
    const budget = resolvePushdownTimeoutMs(Date.now() + 5_000);
    expect(budget).toBeLessThanOrEqual(5_000);
    expect(budget).toBeGreaterThan(4_000);
  });

  it('never lets a distant deadline exceed the cap', () => {
    expect(resolvePushdownTimeoutMs(Date.now() + 10 * 60_000)).toBe(PUSHDOWN_QUERY_TIMEOUT_MS);
  });

  it('rejects a deadline that has already passed', () => {
    expect(() => resolvePushdownTimeoutMs(Date.now() - 1)).toThrow(/deadline expired/);
  });

  it('stays under the executor default it exists to replace', () => {
    // SubprocessExecutor defaults to 600_000ms; a cap at or above that is no cap.
    expect(PUSHDOWN_QUERY_TIMEOUT_MS).toBeLessThan(600_000);
  });
});
