import { describe, expect, it } from "vitest";
import { buildDispatchMessage } from "../../../watchers/automation";

describe("watcher dispatch message", () => {
	it("instructs the agent to analyze source results when event content is empty", () => {
		const message = buildDispatchMessage({
			watcherId: 13,
			runId: 647146,
			agentId: "personal-agent",
			sessionAgentId: "personal-agent_watcher_13_run_647146",
			payload: {
				watcher_id: 13,
				agent_id: "personal-agent",
				window_start: "2026-07-15T00:00:00.000Z",
				window_end: "2026-07-16T00:00:00.000Z",
				dispatch_source: "manual",
			},
		});

		expect(message).toContain(
			"Analyze every source result in the knowledge-read payload's `sources` field, even when its `content` array is empty.",
		);
		expect(message).toContain(
			"Treat the watcher as having no data only when `content` and every array in `sources` are empty.",
		);
		expect(message).not.toContain(
			"If there is no content, do not fabricate results.",
		);
	});
});
