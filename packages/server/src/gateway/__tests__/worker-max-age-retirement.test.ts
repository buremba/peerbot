/**
 * Worker max-age retirement.
 *
 * The defect: a worker resolves its connector credentials into env once at
 * spawn and cannot be updated in place, so a continuously busy worker keeps
 * serving turns with credentials that have since expired (a GitHub App
 * installation token lives ~1h). Idle cleanup never rescues it — a worker that
 * is always busy is never idle. Measured on prod: 24 of 6,974 warm sessions in
 * 30 days ran past 55 minutes, the longest for 1 day 21 hours.
 *
 * The fix: past `worker.maxAgeMinutes`, shorten the idle threshold so the
 * worker is retired at its first quiet moment. Age bounds the credentials;
 * idleness is what makes retiring safe. Delete the `isPastMaxAge` branch in
 * `buildDeploymentInfoSummary` and the "retired at the first quiet moment" test
 * below goes red.
 */

import { describe, expect, test } from "bun:test";
import {
  buildDeploymentInfoSummary,
  MAX_AGE_IDLE_GRACE_MINUTES,
} from "../orchestration/deployment-utils.js";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();

/** Minutes before NOW, as a Date. */
function minutesAgo(minutes: number): Date {
  return new Date(NOW - minutes * 60 * 1000);
}

function summarize({
  idleMinutes,
  aliveMinutes,
  idleThresholdMinutes = 5,
  maxAgeMinutes = 45,
  trackStartedAt = true,
}: {
  idleMinutes: number;
  aliveMinutes: number;
  idleThresholdMinutes?: number;
  maxAgeMinutes?: number;
  trackStartedAt?: boolean;
}) {
  return buildDeploymentInfoSummary({
    deploymentName: "lobu-worker-api-abc123",
    lastActivity: minutesAgo(idleMinutes),
    ...(trackStartedAt ? { startedAt: minutesAgo(aliveMinutes) } : {}),
    now: NOW,
    idleThresholdMinutes,
    maxAgeMinutes,
    veryOldDays: 7,
    replicas: 1,
  });
}

describe("worker max-age retirement", () => {
  test("a worker past max age is retired at its first quiet moment", () => {
    // Alive 50min (past the 45min cap) and quiet for just over the grace
    // window. Ordinary idle cleanup would wait the full 5 minutes; the cap
    // retires it now, before it serves another turn on a dying credential.
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 50,
    });

    expect(info.isPastMaxAge).toBe(true);
    expect(info.isIdle).toBe(true);
  });

  test("the same quiet window does NOT retire a worker under max age", () => {
    // Identical idleness, only younger. This is what proves the age cap — not
    // some change in idleness semantics — is what retired the worker above.
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 10,
    });

    expect(info.isPastMaxAge).toBe(false);
    expect(info.isIdle).toBe(false);
  });

  test("a BUSY worker past max age is never retired — no mid-turn kill", () => {
    // The safety property. A worker running a turn has fresh activity, so it is
    // not idle by definition and the cap cannot reach it. Retiring here would
    // SIGTERM an in-flight answer and cost the user a reply.
    const info = summarize({ idleMinutes: 0, aliveMinutes: 600 });

    expect(info.isPastMaxAge).toBe(true);
    expect(info.isIdle).toBe(false);
  });

  test("the cap only shortens the idle threshold, never lengthens it", () => {
    // A deployment whose idle threshold is already shorter than the grace
    // window must keep its own threshold — the cap is a floor on eagerness, not
    // a replacement policy.
    const info = summarize({
      idleMinutes: 0.2,
      aliveMinutes: 600,
      idleThresholdMinutes: 0.1,
    });

    expect(info.isPastMaxAge).toBe(true);
    expect(info.isIdle).toBe(true);
  });

  test("maxAgeMinutes = 0 disables the cap (pre-cap behavior)", () => {
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 600,
      maxAgeMinutes: 0,
    });

    expect(info.isPastMaxAge).toBe(false);
    expect(info.isIdle).toBe(false);
  });

  test("a caller that does not track spawn time keeps the old behavior", () => {
    // `startedAt` is optional so partially-built callers still compile. Age
    // unknown must mean "cap cannot apply", never "assume it is old".
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 600,
      trackStartedAt: false,
    });

    expect(info.isPastMaxAge).toBe(false);
    expect(info.isIdle).toBe(false);
  });

  test("idleness and very-old classification are unchanged by the cap", () => {
    const info = summarize({ idleMinutes: 60 * 24 * 8, aliveMinutes: 60 * 24 * 8 });

    expect(info.isVeryOld).toBe(true);
    expect(info.isIdle).toBe(true);
  });
});
