/**
 * Run provenance derivation. Pure, so the precedence between the identity
 * channels is pinned here rather than only through database round-trips.
 */

import { describe, expect, it } from "vitest";
import { initiatorRunColumns, resolveInitiator } from "../../tools/initiator";

describe("resolveInitiator", () => {
	it("names the agent session, the client, and the human behind it", () => {
		// The orphan case: this is exactly the shape an MCP tool call arrives with.
		expect(
			resolveInitiator({
				userId: "user_1",
				agentId: "personal-agent",
				clientId: "claude-ai",
				sourceContext: { platform: "mcp", conversationId: "conv-1" },
			}),
		).toEqual({
			kind: "agent_session",
			agentId: "personal-agent",
			userId: "user_1",
			clientId: "claude-ai",
			conversationId: "conv-1",
		});
	});

	it("classifies a reaction as its behavior, not its owning agent", () => {
		// A reaction carries BOTH a watcher and its owning agent's id. If the agent
		// branch won, every behavior run would be misfiled as an agent session.
		expect(
			resolveInitiator({
				userId: null,
				agentId: "personal-agent",
				actingWatcherId: 42,
				actingWindowId: 7,
				actingRunId: 99,
			}),
		).toEqual({
			kind: "behavior",
			watcherId: 42,
			windowId: 7,
			runId: 99,
		});
	});

	it("classifies a plain human session as a user", () => {
		expect(resolveInitiator({ userId: "user_1" })).toEqual({
			kind: "user",
			userId: "user_1",
		});
	});

	it("falls back to system for hand-built internal contexts", () => {
		expect(resolveInitiator({})).toEqual({ kind: "system" });
	});

	it("keeps an initiator the entry point already stamped", () => {
		// Entry points know things inference cannot (a schedule looks like nothing
		// else on the context), so an explicit stamp must never be second-guessed.
		const stamped = { kind: "schedule", scheduleId: 5, runId: 12 } as const;
		expect(resolveInitiator({ initiator: stamped, userId: "user_1" })).toEqual(
			stamped,
		);
	});
});

describe("initiatorRunColumns", () => {
	it("attributes an agent session to the human whose session authorized it", () => {
		expect(
			initiatorRunColumns({
				kind: "agent_session",
				agentId: "personal-agent",
				userId: "user_1",
				clientId: "claude-ai",
				conversationId: null,
			}),
		).toEqual({
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: "personal-agent",
				user_id: "user_1",
				client_id: "claude-ai",
				conversation_id: null,
			},
			createdByUserId: "user_1",
		});
	});

	it("leaves an autonomous behavior run unattributed to any human", () => {
		// created_by_user_id means "a person asked for this". A behavior fires
		// unattended, so borrowing its owner's id would misreport who acted.
		const columns = initiatorRunColumns({
			kind: "behavior",
			watcherId: 42,
			windowId: 7,
			runId: 99,
		});
		expect(columns.createdByUserId).toBeNull();
		expect(columns.initiatorRef).toEqual({
			watcher_id: 42,
			window_id: 7,
			run_id: 99,
		});
	});

	it("produces a JSON-serializable ref for every kind", () => {
		// The ref rides a jsonb column; an undefined would silently drop a field.
		const kinds = [
			{ kind: "user", userId: "user_1" },
			{ kind: "behavior", watcherId: 1, windowId: null, runId: null },
			{
				kind: "agent_session",
				agentId: null,
				userId: null,
				clientId: null,
				conversationId: null,
			},
			{ kind: "schedule", scheduleId: 1, runId: null },
			{ kind: "system" },
		] as const;
		for (const initiator of kinds) {
			const { initiatorKind, initiatorRef } = initiatorRunColumns(initiator);
			expect(initiatorKind).toBe(initiator.kind);
			expect(JSON.parse(JSON.stringify(initiatorRef))).toEqual(initiatorRef);
		}
	});
});
