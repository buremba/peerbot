/** Age-aware idle classification used by worker retirement reconciliation. */

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
}: {
  idleMinutes: number;
  aliveMinutes: number;
  idleThresholdMinutes?: number;
  maxAgeMinutes?: number;
}) {
  return buildDeploymentInfoSummary({
    deploymentName: "lobu-worker-api-abc123",
    lastActivity: minutesAgo(idleMinutes),
    startedAt: minutesAgo(aliveMinutes),
    now: NOW,
    idleThresholdMinutes,
    maxAgeMinutes,
    veryOldDays: 7,
    replicas: 1,
  });
}

describe("worker max-age retirement", () => {
  test("an aged worker qualifies after the shorter quiet window", () => {
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 50,
    });

    expect(info.isPastMaxAge).toBe(true);
    expect(info.isIdle).toBe(true);
  });

  test("the same quiet window does NOT retire a worker under max age", () => {
    const info = summarize({
      idleMinutes: MAX_AGE_IDLE_GRACE_MINUTES + 0.1,
      aliveMinutes: 10,
    });

    expect(info.isPastMaxAge).toBe(false);
    expect(info.isIdle).toBe(false);
  });

  test("recent worker activity does not qualify for retirement", () => {
    const info = summarize({ idleMinutes: 0, aliveMinutes: 600 });

    expect(info.isPastMaxAge).toBe(true);
    expect(info.isIdle).toBe(false);
  });

  test("the cap only shortens the idle threshold, never lengthens it", () => {
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

  test("idleness and very-old classification are unchanged by the cap", () => {
    const info = summarize({ idleMinutes: 60 * 24 * 8, aliveMinutes: 60 * 24 * 8 });

    expect(info.isVeryOld).toBe(true);
    expect(info.isIdle).toBe(true);
  });
});
