import { describe, expect, test } from "bun:test";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import {
	assertAutomationInstructions,
	automationRequiresInstructions,
} from "../../automations/triggers";

const eventTurn: AutomationTrigger = {
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
} as AutomationTrigger;

const eventWindow: AutomationTrigger = {
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
	execution: "window",
};

const workspaceEventDefault: AutomationTrigger = {
	kind: "event",
	source: "workspace",
	event_types: ["risk_detected"],
};

const schedule: AutomationTrigger = {
	kind: "schedule",
	cron: "0 9 * * *",
};

describe("automationRequiresInstructions", () => {
	test("event-turn triggers (explicit or defaulted) do not require instructions", () => {
		expect(automationRequiresInstructions([eventTurn])).toBe(false);
		expect(automationRequiresInstructions([eventDefault])).toBe(false);
		expect(automationRequiresInstructions([eventTurn, eventDefault])).toBe(false);
	});

	test("schedule, window-event, and empty (manual) trigger sets require instructions", () => {
		expect(automationRequiresInstructions([schedule])).toBe(true);
		expect(automationRequiresInstructions([eventWindow])).toBe(true);
		expect(automationRequiresInstructions([workspaceEventDefault])).toBe(true);
		expect(automationRequiresInstructions([])).toBe(true);
		// Mixed: one non-turn trigger is enough.
		expect(automationRequiresInstructions([eventTurn, schedule])).toBe(true);
	});
});

describe("assertAutomationInstructions", () => {
	test("allows an event-turn Automation with no instruction text", () => {
		expect(() => assertAutomationInstructions([eventTurn], undefined)).not.toThrow();
		expect(() => assertAutomationInstructions([eventTurn], "")).not.toThrow();
	});

	test("rejects empty instructions for schedule/window/manual shapes", () => {
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as AutomationTrigger[],
		]) {
			expect(() => assertAutomationInstructions(triggers, undefined)).toThrow(
				/needs instructions/
			);
			expect(() => assertAutomationInstructions(triggers, "   ")).toThrow(
				/needs instructions/
			);
		}
	});

	test("accepts any trigger shape once instruction text is present", () => {
		expect(() =>
			assertAutomationInstructions([schedule], "Do the digest.")
		).not.toThrow();
		expect(() => assertAutomationInstructions([], "Manual runbook.")).not.toThrow();
	});
});
