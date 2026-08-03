import type { MemoryResource } from "../utils/url-builder";
import type { ToolContext } from "./registry";

/**
 * Verified context fields used to derive run provenance. Tool arguments are
 * deliberately excluded because callers control them.
 */
type InitiatorSource = Partial<
	Pick<
		ToolContext,
		| "userId"
		| "agentId"
		| "clientId"
		| "sourceContext"
		| "actingBehaviorId"
		| "actingWindowId"
		| "actingRunId"
	>
>;

type RunInitiatorColumns = {
	initiatorKind: "user" | "behavior" | "agent_session" | "system";
	initiatorRef: Record<string, unknown>;
	createdByUserId: string | null;
};

export function resolveRunInitiator(ctx: InitiatorSource): RunInitiatorColumns {
	if (ctx.actingBehaviorId != null) {
		return {
			initiatorKind: "behavior",
			initiatorRef: {
				behavior_id: ctx.actingBehaviorId,
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

/** Map persisted provenance to a run link, falling back if the route is incomplete. */
export function runPermalinkResource(
	initiator: {
		initiatorKind?: string | null;
		initiatorRef?: Record<string, unknown> | null;
	},
	runId: number,
	ownerAgentId: string | null | undefined,
): MemoryResource {
	if (initiator.initiatorKind !== "behavior" || !ownerAgentId) {
		return { kind: "run", runId };
	}
	// Reject the empty cases before coercing: Number(null) and Number("") are
	// both 0, a valid-looking id that would build a link to "Behavior 0".
	const rawBehaviorId = initiator.initiatorRef?.behavior_id;
	if (rawBehaviorId == null || rawBehaviorId === "") {
		return { kind: "run", runId };
	}
	const behaviorId = Number(rawBehaviorId);
	if (!Number.isSafeInteger(behaviorId) || behaviorId <= 0) {
		return { kind: "run", runId };
	}
	return {
		kind: "behavior_run",
		runId,
		agentId: ownerAgentId,
		behaviorId,
	};
}
