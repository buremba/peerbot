/**
 * Unit coverage for computeBehaviorHealth.
 *
 * The gap this closes: health considered only the scheduler cursor (missed
 * firing / stuck pending), so a behavior whose latest run FAILED still reported
 * `healthy` — the exact "health:healthy beside a failed run" contradiction the
 * audit found. A terminal failed/timeout latest run now degrades health.
 */

import { describe, expect, it } from "bun:test";
import { computeBehaviorHealth } from "../../watchers/behavior-health";

const NOW = 1_700_000_000_000;

describe("computeBehaviorHealth", () => {
	it("degrades an active behavior whose latest run failed", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(), // on schedule
				latestRunStatus: "failed",
				latestRunError: "No model is configured",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.last_scheduling_error).toBe("No model is configured");
		expect(result.reasons.join(" ")).toContain("No model is configured");
	});

	it("degrades on a timeout latest run too", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "timeout",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
	});

	it("stays healthy when the latest run succeeded and the schedule is current", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.reasons).toHaveLength(0);
	});

	it("does not degrade a non-active behavior even with a failed run (archived is intentionally idle)", () => {
		const result = computeBehaviorHealth(
			{
				status: "archived",
				nextRunAt: new Date(NOW - 10_000_000).toISOString(),
				latestRunStatus: "failed",
				latestRunError: "old failure",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		// still echoes the error for context
		expect(result.last_scheduling_error).toBe("old failure");
	});

	it("still degrades on a missed firing when the run did not fail (regression)", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h overdue
				latestRunStatus: "completed",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons.join(" ")).toContain("missed firing");
	});

	it("does not false-degrade a failed cursor while a run is in flight", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
				latestRunStatus: "running",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
	});
});
