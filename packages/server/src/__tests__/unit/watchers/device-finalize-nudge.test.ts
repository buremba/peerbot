import { describe, expect, it } from "bun:test";
import { resolveFinalizeNudgeBudget } from "../../../watchers/run-completion";

describe("resolveFinalizeNudgeBudget", () => {
	it("uses global default when execution_config omits finalize_nudges", () => {
		// Default LOBU_WATCHER_FINALIZE_NUDGES is 1 unless env overrides.
		const n = resolveFinalizeNudgeBudget(null);
		expect(n).toBeGreaterThanOrEqual(0);
		expect(n).toBeLessThanOrEqual(5);
	});

	it("honors per-watcher override clamped to 0–5", () => {
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
