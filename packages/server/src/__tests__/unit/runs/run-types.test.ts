import { describe, expect, test } from "bun:test";
import {
	BEHAVIOR_EVAL_RUN_TYPE,
	BEHAVIOR_RUN_TYPE,
	BEHAVIOR_RUN_TYPES,
	executionModeForRunType,
} from "../../../runs/run-types";

describe("executionModeForRunType", () => {
	test("a real Behavior run executes for real", () => {
		expect(executionModeForRunType(BEHAVIOR_RUN_TYPE)).toBe("live");
	});

	test("an eval replay captures", () => {
		expect(executionModeForRunType(BEHAVIOR_EVAL_RUN_TYPE)).toBe("capture");
	});

	// The whole point of deriving the mode rather than passing it: anything we
	// do not positively recognise as a live Behavior must not reach the outside
	// world. A future run type that forgets to declare itself captures.
	test.each([
		["sync", "sync"],
		["chat_message", "chat_message"],
		["a run type invented later", "behavior_eval_v2"],
		["empty string", ""],
		["null", null],
		["undefined", undefined],
	])("%s fails closed to capture", (_label, runType) => {
		expect(executionModeForRunType(runType)).toBe("capture");
	});

	test("only the exact literal is live — no prefix or case slack", () => {
		for (const near of ["Behavior", "behavior ", " behavior", "behaviour"]) {
			expect(executionModeForRunType(near)).toBe("capture");
		}
	});
});

describe("BEHAVIOR_RUN_TYPES", () => {
	test("is exactly the two execution-path run types", () => {
		expect([...BEHAVIOR_RUN_TYPES].sort()).toEqual(
			["behavior", "behavior_eval"].sort(),
		);
	});

	test("every member has a defined mode, and exactly one is live", () => {
		const live = BEHAVIOR_RUN_TYPES.filter(
			(t) => executionModeForRunType(t) === "live",
		);
		expect(live).toEqual([BEHAVIOR_RUN_TYPE]);
	});
});
