import { describe, expect, it } from "vitest";
import { buildDispatchMessage } from "../../../watchers/automation";

describe("watcher dispatch message", () => {
	it("dereferences workspace-event turn inputs instead of embedding event content", () => {
		const message = buildDispatchMessage({
			watcherId: 21,
			runId: 88,
			agentId: "risk-agent",
			sessionAgentId: "risk-agent_watcher_21_run_88",
			payload: {
				watcher_id: 21,
				agent_id: "risk-agent",
				window_start: "2026-08-11T00:00:00.000Z",
				window_end: "2026-08-11T00:00:00.001Z",
				dispatch_source: "event",
				version_id: 3,
				trigger_execution: "turn",
				trigger_signal: {
					kind: "event",
					source: "workspace",
					event_id: 40,
					event_type: "risk_detected",
					delivery_id: "workspace-event:40",
					occurred_at: "2026-08-11T00:00:00.000Z",
					root_event_ids: [40],
					causal_behavior_ids: [7],
					depth: 1,
				},
			},
		});

		expect(message).toContain("client.knowledge.read({ content_ids: [40] })");
		expect(message).toContain("pointer and causal metadata only");
		expect(message).not.toContain("normalized connector event");
	});

	it("signs workspace-event pointers into window reads", () => {
		const message = buildDispatchMessage({
			watcherId: 21,
			runId: 89,
			agentId: "risk-agent",
			sessionAgentId: "risk-agent_watcher_21_run_89",
			payload: {
				watcher_id: 21,
				agent_id: "risk-agent",
				window_start: "2026-08-11T00:00:00.000Z",
				window_end: "2026-08-11T00:00:00.001Z",
				dispatch_source: "event",
				version_id: 3,
				trigger_execution: "window",
				trigger_signal: {
					kind: "event",
					source: "workspace",
					event_id: 40,
					event_type: "risk_detected",
					delivery_id: "workspace-event:40",
					occurred_at: "2026-08-11T00:00:00.000Z",
					root_event_ids: [40],
					causal_behavior_ids: [7],
					depth: 1,
				},
			},
		});

		expect(message).toContain("content_ids: [40]");
		expect(message).toContain("signs its exact id into the window_token");
		expect(message).toContain("Analyze each trigger input exactly once");
	});

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
