import { describe, expect, it } from "bun:test";
import { AgentErrorCode } from "@lobu/core";
import { classifyRunOutcome } from "../../../runs/run-outcome";

describe("classifyRunOutcome", () => {
	it("marks completed runs scoreable", () => {
		expect(classifyRunOutcome({ status: "completed" })).toBe("scoreable");
	});

	it("marks every timeout infra_error regardless of message", () => {
		expect(classifyRunOutcome({ status: "timeout" })).toBe("infra_error");
		expect(
			classifyRunOutcome({
				status: "timeout",
				errorMessage:
					"Behavior run remained pending for over 2 hours without being claimed",
			}),
		).toBe("infra_error");
	});

	it("returns null for non-terminal and cancelled runs", () => {
		for (const status of ["pending", "claimed", "running", "cancelled"]) {
			expect(classifyRunOutcome({ status })).toBeNull();
		}
	});

	it("maps every catalogued AgentErrorCode to infra_error", () => {
		for (const code of Object.values(AgentErrorCode)) {
			expect(
				classifyRunOutcome({
					status: "failed",
					errorCode: code,
					errorMessage: "irrelevant",
				}),
			).toBe("infra_error");
		}
	});

	// The message corpus below is verbatim from prod (14-day window, 2026-08-06)
	// — the z.ai quota storm that motivated the taxonomy plus the long tail.
	const PROD_INFRA_MESSAGES = [
		"z.ai returned an error:\n429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-01",
		"429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-31 04:32:47",
		"429 Usage limit reached for 5 hour. Your limit will reset at 2026-07-24 09:00:22",
		"z.ai returned an error:\n429 Insufficient balance or no resource package. Please recharge.",
		"Gemini returned an error:\n429 status code (no body)",
		"The agent didn't finish responding in time. This is usually temporary — please try again.",
		"The operation timed out.",
		'Failed to create or resume Lobu agent session (401): {"success":false,"error":"Unauthorized"}',
		'Failed to enqueue Lobu Behavior message (401): {"success":false,"error":"Unauthorized"}',
		"no local agent executor configured for agent_kind='opencode'",
		"claude exited via SIGKILL after 300s timeout",
		"agy exited with status 1: Authentication required. Please visit the URL to log in:\n  https://example.com",
		"Behavior run blocked on tool approval after 2 attempt(s): lobu-memory/run_sdk queued for human approval, so complete_window never ran.",
	];

	it.each(
		PROD_INFRA_MESSAGES,
	)("classifies prod infra message as infra_error: %s", (message) => {
		expect(
			classifyRunOutcome({ status: "failed", errorMessage: message }),
		).toBe("infra_error");
	});

	const PROD_AGENT_MESSAGES = [
		"Agent reply finished without calling run_sdk (client.behaviors.completeWindow) after 2 attempt(s). No active tool approval was found, so check that the assigned agent has the lobu-memory MCP attached.",
		"Device CLI exited without calling completeWindow after 2 attempt(s). Use the lobu skill + `lobu memory exec` (knowledge.read → completeWindow) or MCP query_sdk/run_sdk.",
		"claude exited with non-zero status 1",
	];

	it.each(
		PROD_AGENT_MESSAGES,
	)("classifies prod agent-fault message as agent_error: %s", (message) => {
		expect(
			classifyRunOutcome({ status: "failed", errorMessage: message }),
		).toBe("agent_error");
	});

	it("defaults unknown failures to agent_error (fail toward visibility)", () => {
		expect(
			classifyRunOutcome({
				status: "failed",
				errorMessage: "manual reclaim after e2e prep",
			}),
		).toBe("agent_error");
		expect(classifyRunOutcome({ status: "failed" })).toBe("agent_error");
	});
});
