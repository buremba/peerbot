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
		expect(result.last_run_outcome).toBeNull();
	});

	it("labels the degraded reason with the stamped run outcome", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "failed",
				latestRunError: "z.ai returned an error:\n429 Weekly/Monthly Limit Exhausted",
				latestRunOutcome: "infra_error",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.last_run_outcome).toBe("infra_error");
		expect(result.reasons.join(" ")).toContain("latest run failed (infra_error)");
	});

	it("echoes a scoreable outcome on a healthy behavior", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
				latestRunOutcome: "scoreable",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.last_run_outcome).toBe("scoreable");
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

	it("does not degrade an archived behavior whose latest run failed", () => {
		const result = computeBehaviorHealth(
			{
				status: "archived",
				nextRunAt: new Date(NOW - 10_000_000).toISOString(),
				latestRunStatus: "failed",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
	});

	it("still degrades on a missed firing when the run did not fail (regression)", () => {
		const result = computeBehaviorHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
				latestRunStatus: "completed",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons.join(" ")).toContain("missed firing");
	});

	it("does not degrade an overdue schedule while a run is in flight", () => {
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
