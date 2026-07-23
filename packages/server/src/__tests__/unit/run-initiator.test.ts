import { describe, expect, it } from "vitest";
import { resolveRunInitiator } from "../../tools/initiator";

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
