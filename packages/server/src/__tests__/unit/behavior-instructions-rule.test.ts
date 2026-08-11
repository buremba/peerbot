import { describe, expect, test } from "bun:test";
import type { BehaviorTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import {
	assertBehaviorInstructions,
	behaviorRequiresInstructions,
} from "../../behaviors/triggers";

const eventTurn: BehaviorTrigger = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
	execution: "turn",
};

// An omitted execution defaults to "turn" per the contract schema.
const eventDefault = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
} as BehaviorTrigger;

const eventWindow: BehaviorTrigger = {
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
	execution: "window",
};

const workspaceEventDefault: BehaviorTrigger = {
	kind: "event",
	source: "workspace",
	event_types: ["risk_detected"],
};

const schedule: BehaviorTrigger = {
	kind: "schedule",
	cron: "0 9 * * *",
};

describe("behaviorRequiresInstructions", () => {
	test("event-turn triggers (explicit or defaulted) do not require instructions", () => {
		expect(behaviorRequiresInstructions([eventTurn])).toBe(false);
		expect(behaviorRequiresInstructions([eventDefault])).toBe(false);
		expect(behaviorRequiresInstructions([eventTurn, eventDefault])).toBe(false);
	});

	test("schedule, window-event, and empty (manual) trigger sets require instructions", () => {
		expect(behaviorRequiresInstructions([schedule])).toBe(true);
		expect(behaviorRequiresInstructions([eventWindow])).toBe(true);
		expect(behaviorRequiresInstructions([workspaceEventDefault])).toBe(true);
		expect(behaviorRequiresInstructions([])).toBe(true);
		// Mixed: one non-turn trigger is enough.
		expect(behaviorRequiresInstructions([eventTurn, schedule])).toBe(true);
	});
});

describe("assertBehaviorInstructions", () => {
	test("allows an event-turn Behavior with no instruction text", () => {
		expect(() => assertBehaviorInstructions([eventTurn], undefined)).not.toThrow();
		expect(() => assertBehaviorInstructions([eventTurn], "")).not.toThrow();
	});

	test("rejects empty instructions for schedule/window/manual shapes", () => {
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as BehaviorTrigger[],
		]) {
			expect(() => assertBehaviorInstructions(triggers, undefined)).toThrow(
				/needs instructions/
			);
			expect(() => assertBehaviorInstructions(triggers, "   ")).toThrow(
				/needs instructions/
			);
		}
	});

	test("accepts any trigger shape once instruction text is present", () => {
		expect(() =>
			assertBehaviorInstructions([schedule], "Do the digest.")
		).not.toThrow();
		expect(() => assertBehaviorInstructions([], "Manual runbook.")).not.toThrow();
	});
});
