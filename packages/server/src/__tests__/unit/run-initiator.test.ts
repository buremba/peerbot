import { describe, expect, it } from "vitest";
import {
	resolveRunInitiator,
	runPermalinkResource,
} from "../../tools/initiator";

describe("resolveRunInitiator", () => {
	it("records the agent session, client, and authorizing human", () => {
		expect(
			resolveRunInitiator({
				userId: "user_1",
				agentId: "personal-agent",
				clientId: "claude-ai",
				sourceContext: { platform: "mcp", conversationId: "conv-1" },
			}),
		).toEqual({
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: "personal-agent",
				user_id: "user_1",
				client_id: "claude-ai",
				conversation_id: "conv-1",
			},
			createdByUserId: "user_1",
		});
	});

	it("classifies a reaction as its behavior, not its owning agent", () => {
		expect(
			resolveRunInitiator({
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 42,
				actingWindowId: 7,
				actingRunId: 99,
			}),
		).toEqual({
			initiatorKind: "behavior",
			initiatorRef: {
				watcher_id: 42,
				window_id: 7,
				run_id: 99,
			},
			createdByUserId: null,
		});
	});

	it("records a plain human session", () => {
		expect(resolveRunInitiator({ userId: "user_1" })).toEqual({
			initiatorKind: "user",
			initiatorRef: { user_id: "user_1" },
			createdByUserId: "user_1",
		});
	});

	it("falls back to system for hand-built internal contexts", () => {
		expect(resolveRunInitiator({})).toEqual({
			initiatorKind: "system",
			initiatorRef: {},
			createdByUserId: null,
		});
	});
});

describe("runPermalinkResource", () => {
	const behavior = {
		initiatorKind: "behavior",
		initiatorRef: { watcher_id: 42, window_id: 7, run_id: 99 },
	};

	it("sends a Behavior's run to that Behavior's drill-down", () => {
		expect(runPermalinkResource(behavior, 500, "personal-agent")).toEqual({
			kind: "behavior_run",
			runId: 500,
			agentId: "personal-agent",
			behaviorId: 42,
		});
	});

	it("falls back to the workspace log when the owning agent is unknown", () => {
		expect(runPermalinkResource(behavior, 500, null)).toEqual({
			kind: "run",
			runId: 500,
		});
	});

	it("leaves non-Behavior runs on the workspace log", () => {
		expect(
			runPermalinkResource(
				{
					initiatorKind: "agent_session",
					initiatorRef: { agent_id: "personal-agent" },
				},
				500,
				"personal-agent",
			),
		).toEqual({ kind: "run", runId: 500 });
	});

	it("falls back for runs recorded before provenance existed", () => {
		expect(runPermalinkResource({}, 500, "personal-agent")).toEqual({
			kind: "run",
			runId: 500,
		});
	});

	it.each([
		null,
		"",
		0,
		-1,
		1.5,
		"not-a-number",
	])("falls back when a behavior ref carries watcher id %j", (watcherId) => {
		expect(
			runPermalinkResource(
				{ initiatorKind: "behavior", initiatorRef: { watcher_id: watcherId } },
				500,
				"personal-agent",
			),
		).toEqual({ kind: "run", runId: 500 });
	});
});
