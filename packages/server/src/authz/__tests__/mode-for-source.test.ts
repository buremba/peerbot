import { describe, expect, it } from "vitest";
import { modeForSource } from "../entity-policy";

/**
 * `modeForSource` classifies a run's worker-token `source` claim as attended (a
 * human is in the loop) or autonomous (a server-dispatched, no-human turn). The
 * autonomous set MUST cover every headless source that bypasses the SSE-owner
 * gate — otherwise a no-human turn evaluates as attended and skips an agent's
 * autonomous-only restrictions. This locks that set (the P1 regression: the
 * headless `connector-repair` and `internal` sources were missing).
 */
describe("modeForSource", () => {
	it("classes every headless (no-human) source as autonomous", () => {
		for (const source of [
			"watcher-run",
			"scheduled-job",
			"connector-repair",
			"internal",
		]) {
			expect(modeForSource(source)).toBe("autonomous");
		}
	});

	it("classes an interactive turn as attended", () => {
		for (const source of ["direct-api", "slack", "telegram", "web", "chat"]) {
			expect(modeForSource(source)).toBe("attended");
		}
	});

	it("defaults an unknown/absent source to attended (never looser than autonomous)", () => {
		expect(modeForSource(null)).toBe("attended");
		expect(modeForSource(undefined)).toBe("attended");
		expect(modeForSource("some-future-unmapped-source")).toBe("attended");
	});
});
