import { describe, expect, it } from "bun:test";
import { resolveFinalizeNudgeBudget } from "../../../automations/run-completion";

describe("resolveFinalizeNudgeBudget", () => {
	it("keeps the global budget within the device safety range", () => {
		const n = resolveFinalizeNudgeBudget(null);
		expect(Number.isInteger(n)).toBe(true);
		expect(n).toBeGreaterThanOrEqual(0);
		expect(n).toBeLessThanOrEqual(5);
	});

	it("honors per-automation override clamped to 0–5", () => {
		expect(resolveFinalizeNudgeBudget({ finalize_nudges: 0 })).toBe(0);
		expect(resolveFinalizeNudgeBudget({ finalize_nudges: 3 })).toBe(3);
		expect(resolveFinalizeNudgeBudget({ finalize_nudges: 99 })).toBe(5);
		expect(resolveFinalizeNudgeBudget({ finalize_nudges: -2 })).toBe(0);
	});

	it("ignores non-numeric overrides", () => {
		const fallback = resolveFinalizeNudgeBudget(null);
		expect(
			resolveFinalizeNudgeBudget({ finalize_nudges: "2" as unknown as number })
		).toBe(fallback);
	});
});
