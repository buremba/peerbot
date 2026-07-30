/**
 * Does this agent turn belong to a Behavior its operator declared unattended?
 *
 * Scheduled runs cannot answer an MCP approval card. Their Behavior-scoped
 * `execution_config.permission_mode` decides whether the call may proceed.
 *
 * WHY THE CONVERSATION SUFFIX AND NOT `tokenData.runId` — this is the trap that
 * produced the first, wrong version of this policy: the token's `runId` is the
 * `chat_message` QUEUE row that dispatched the turn, not the parent `behavior`
 * row (`buildRunJobToken` stamps it from the queue payload), so joining
 * `runs.watcher_id` on it matches nothing in production. The Behavior/run pair instead travels in the signed conversation-id
 * suffix. `POST /api/v1/agents` makes that suffix trustworthy by accepting the
 * intent only with the dispatcher's short-lived internal token and rejecting
 * the same packed suffix on ordinary sessions; see `behavior-run-intent.ts`.
 */

import { type DbClient, getDb } from "../../db/client.js";
import { parseBehaviorRunConversationId } from "./behavior-run-intent.js";
import { UNATTENDED_PERMISSION_MODES } from "../../tools/admin/behavior-execution-config.js";
import logger from "../../utils/logger.js";

export interface UnattendedRunScope {
	/** Signed conversation id from the worker token. */
	conversationId: string | undefined;
	/** Signed owning org from the worker token. */
	organizationId: string | undefined;
	/** Signed agent id from the worker token. */
	agentId: string | undefined;
}

/**
 * True when this turn is a Behavior run whose Behavior is configured for
 * unattended execution.
 *
 * The query re-checks the signed token's org and agent against both the
 * Behavior and run. Interactive conversations do not carry the suffix.
 * Any parse or database failure keeps the approval requirement.
 */
export async function runAllowsUnattendedToolUse(
	scope: UnattendedRunScope,
	db?: DbClient,
): Promise<boolean> {
	if (!scope.conversationId || !scope.organizationId || !scope.agentId) {
		return false;
	}
	const correlation = parseBehaviorRunConversationId(scope.conversationId);
	if (!correlation) return false;
	const { behaviorId: watcherId, runId: behaviorRunId } = correlation;

	try {
		const sql = db ?? getDb();
		// The two `organization_id` predicates are redundant BY DESIGN, and the
		// redundancy is load-bearing rather than sloppy: a Behavior and its run
		// always share an org today, so either one alone holds the tenant
		// boundary (mutation-tested — dropping either keeps the suite green,
		// dropping both turns it red). Requiring both means a future write path
		// that lets those two diverge cannot silently open a cross-tenant read
		// here. Do not "simplify" one away.
		const rows = await sql`
      SELECT w.execution_config->>'permission_mode' AS permission_mode
      FROM watchers w
      JOIN runs behavior_run ON behavior_run.watcher_id = w.id
      WHERE w.id = ${watcherId}
        AND w.organization_id = ${scope.organizationId}
        AND w.agent_id = ${scope.agentId}
        AND behavior_run.id = ${behaviorRunId}
        AND behavior_run.run_type = 'behavior'
        AND behavior_run.organization_id = ${scope.organizationId}
      LIMIT 1
    `;
		const mode = rows[0]?.permission_mode as string | null | undefined;
		return mode != null && UNATTENDED_PERMISSION_MODES.has(mode);
	} catch (error) {
		logger.warn(
			{ error, conversation_id: scope.conversationId },
			"[mcp] Could not read a Behavior's permission_mode — requiring tool approval",
		);
		return false;
	}
}
