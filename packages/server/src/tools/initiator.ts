import type { ToolContext } from "./registry";

/**
 * Verified context fields used to derive run provenance. Tool arguments are
 * deliberately excluded because callers control them.
 */
type InitiatorSource = Pick<
	ToolContext,
	| "userId"
	| "agentId"
	| "clientId"
	| "sourceContext"
	| "actingWatcherId"
	| "actingWindowId"
	| "actingRunId"
>;

type RunInitiatorColumns = {
	initiatorKind: "user" | "behavior" | "agent_session" | "system";
	initiatorRef: Record<string, unknown>;
	createdByUserId: string | null;
};

export function resolveRunInitiator(ctx: InitiatorSource): RunInitiatorColumns {
	if (ctx.actingWatcherId != null) {
		return {
			initiatorKind: "behavior",
			initiatorRef: {
				watcher_id: ctx.actingWatcherId,
				window_id: ctx.actingWindowId ?? null,
				run_id: ctx.actingRunId ?? null,
			},
			createdByUserId: null,
		};
	}

	if (ctx.agentId) {
		return {
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: ctx.agentId,
				user_id: ctx.userId ?? null,
				client_id: ctx.clientId ?? null,
				conversation_id: ctx.sourceContext?.conversationId ?? null,
			},
			createdByUserId: ctx.userId ?? null,
		};
	}

	if (ctx.userId) {
		return {
			initiatorKind: "user",
			initiatorRef: { user_id: ctx.userId },
			createdByUserId: ctx.userId,
		};
	}

	return {
		initiatorKind: "system",
		initiatorRef: {},
		createdByUserId: null,
	};
}
