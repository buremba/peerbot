import { describe, expect, test } from "bun:test";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	AUTOMATION_RUN_TYPE,
	AUTOMATION_RUN_TYPES,
	executionModeForRunType,
} from "../../../runs/run-types";

describe("executionModeForRunType", () => {
	test("a real Automation run executes for real", () => {
		expect(executionModeForRunType(AUTOMATION_RUN_TYPE)).toBe("live");
	});

	test("an eval replay captures", () => {
		expect(executionModeForRunType(AUTOMATION_EVAL_RUN_TYPE)).toBe("capture");
	});

	// The whole point of deriving the mode rather than passing it: anything we
	// do not positively recognise as a live Automation must not reach the outside
	// world. A future run type that forgets to declare itself captures.
	test.each([
		["sync", "sync"],
		["chat_message", "chat_message"],
		["a run type invented later", "automation_eval_v2"],
		["empty string", ""],
		["null", null],
		["undefined", undefined],
	])("%s fails closed to capture", (_label, runType) => {
		expect(executionModeForRunType(runType)).toBe("capture");
	});

	test("only the exact literal is live — no prefix or case slack", () => {
		for (const near of ["Automation", "automation ", " automation", "behaviour"]) {
			expect(executionModeForRunType(near)).toBe("capture");
		}
	});
});

describe("AUTOMATION_RUN_TYPES", () => {
	test("is exactly the two execution-path run types", () => {
		expect([...AUTOMATION_RUN_TYPES].sort()).toEqual(
			["automation", "automation_eval"].sort(),
		);
	});

	test("every member has a defined mode, and exactly one is live", () => {
		const live = AUTOMATION_RUN_TYPES.filter(
			(t) => executionModeForRunType(t) === "live",
		);
		expect(live).toEqual([AUTOMATION_RUN_TYPE]);
	});
});
