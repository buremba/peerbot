import { describe, expect, it } from "vitest";
import { buildDispatchMessage } from "../../../behaviors/automation";

// Red twin (pre-fix): `validateTemplate("Ping {{word arg}} when done")`
// returned null (save accepted) while `renderPromptPreview` threw
// `Missing helper: "word"` — a saved prompt 500'd every read path.
// The templating layer is gone; prompts are literal text and ride the
// dispatch message verbatim.
describe("behavior prompt text is literal", () => {
	const prompt = "  Ping {{word arg}} when done\n";

	it("window dispatch embeds the frozen prompt verbatim, braces included", () => {
		const message = buildDispatchMessage({
			behaviorId: 13,
			runId: 647146,
			agentId: "personal-agent",
			sessionAgentId: "personal-agent_behavior_13_run_647146",
			payload: {
				behavior_id: 13,
				agent_id: "personal-agent",
				window_start: "2026-07-15T00:00:00.000Z",
				window_end: "2026-07-16T00:00:00.000Z",
				dispatch_source: "scheduled",
				version_id: null,
			},
			behaviorInstructions: prompt,
		});

		expect(message).toContain("Behavior instructions:");
		expect(message).toContain(prompt);
		expect(message).not.toContain("prompt_rendered");
	});

	it("event dispatch embeds the frozen prompt verbatim, braces included", () => {
		const message = buildDispatchMessage({
			behaviorId: 13,
			runId: 647147,
			agentId: "personal-agent",
			sessionAgentId: "personal-agent_behavior_13_run_647147",
			payload: {
				behavior_id: 13,
				agent_id: "personal-agent",
				window_start: "2026-07-15T00:00:00.000Z",
				window_end: "2026-07-16T00:00:00.000Z",
				dispatch_source: "event",
				version_id: null,
				trigger_signal: {
					connector_key: "slack",
					event_type: "message",
					delivery_id: "d1",
					label: "Message",
					input_text: "hello",
				},
			},
			behaviorInstructions: prompt,
		});

		expect(message).toContain("Behavior instructions:");
		expect(message).toContain(prompt);
	});

	it("window dispatch falls back to a generic instruction when the version has no prompt", () => {
		const message = buildDispatchMessage({
			behaviorId: 13,
			runId: 647148,
			agentId: "personal-agent",
			sessionAgentId: "personal-agent_behavior_13_run_647148",
			payload: {
				behavior_id: 13,
				agent_id: "personal-agent",
				window_start: "2026-07-15T00:00:00.000Z",
				window_end: "2026-07-16T00:00:00.000Z",
				dispatch_source: "manual",
				version_id: null,
			},
		});

		expect(message).toContain(
			"Analyze the window's content and extract findings per the extraction schema.",
		);
	});
});
