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
			"Analyze every source array in the knowledge-read payload's `sources` field, even when the top-level `content` array is empty.",
		);
		expect(message).toContain(
			"Treat the Behavior as having no data only when `content` and every array in `sources` are empty.",
		);
		expect(message).toContain(
			'client.knowledge.read({ behavior_id: 13, since: "2026-07-15", until: "2026-07-15", limit: 25 })',
		);
		expect(message).toContain(
			"If page.has_more is true and you need more evidence, call knowledge.read again with page.next_cursor as before_occurred_at/before_id.",
		);
		expect(message).toContain(
			"Keep the returned window_token from every page you actually analyze.",
		);
		expect(message).toContain(
			"window_tokens: [all window_token values from pages you actually analyzed]",
		);
		expect(message).not.toContain(
			"completeWindow({ window_token, extracted_data",
		);
		expect(message).not.toContain(
			"If there is no content, do not fabricate results.",
		);
	});
});
