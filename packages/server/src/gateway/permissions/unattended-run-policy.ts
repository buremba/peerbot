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
	/**
	 * Per-turn message id from the worker token, minted by the runs-queue
	 * dispatcher for THIS turn. The Behavior run records the one it dispatched
	 * in `runs.dispatched_message_id`, so this is what distinguishes the
	 * dispatcher's own turn from any other turn on the same conversation.
	 */
	messageId: string | undefined;
}

/**
 * True when this turn is a Behavior run whose Behavior is configured for
 * unattended execution.
 *
 * The query re-checks the signed token's org and agent against both the
 * Behavior and run, and binds the TURN to the Behavior run's own dispatch.
 * Any parse or database failure keeps the approval requirement.
 *
 * The conversation suffix alone is NOT sufficient and never was: a session
 * carrying it outlives the dispatch that created it, so a direct/API turn on
 * the same conversation — or a second message an ordinary org member posts
 * into it — would otherwise inherit `bypassPermissions`. `/agent` verifying
 * intent at session creation does not cover that, because the escalation is
 * per-TURN, not per-session. `dispatched_message_id` is the server-authored
 * fact identifying the one turn the dispatcher started for this run:
 * `dispatchWatcherRun` writes it in the same statement that marks the run
 * `running`, BEFORE posting the message the token is minted from.
 */
export async function runAllowsUnattendedToolUse(
	scope: UnattendedRunScope,
	db?: DbClient,
): Promise<boolean> {
	if (
		!scope.conversationId ||
		!scope.organizationId ||
		!scope.agentId ||
		!scope.messageId
	) {
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
        -- Bind this TURN to the Behavior run's own dispatch. A turn the
        -- dispatcher did not start carries a different messageId, so it gets
        -- the approval card even on a conversation whose suffix matches.
        AND behavior_run.dispatched_message_id = ${scope.messageId}
        -- And only while that dispatch is still live: a finished run must not
        -- keep handing out unattended tool use to a resumed session.
        AND behavior_run.status = 'running'
        AND behavior_run.organization_id = ${scope.organizationId}
      LIMIT 1
    `;
		const mode = rows[0]?.permission_mode as string | null | undefined;
		if (mode != null && UNATTENDED_PERMISSION_MODES.has(mode)) return true;
		if (rows.length === 0) {
			await logUnattendedBindMiss(sql, watcherId, behaviorRunId, scope);
		}
		return false;
	} catch (error) {
		logger.warn(
			{ error, conversation_id: scope.conversationId },
			"[mcp] Could not read a Behavior's permission_mode — requiring tool approval",
		);
		return false;
	}
}

/**
 * A Behavior turn asked for unattended tool use and did not get it. Say so.
 *
 * The gate is deliberately narrow, so there are legitimate misses (an
 * interactive turn on a Behavior conversation). But one miss is a FALSE
 * AFFORDANCE and must not be silent: a device-pinned Behavior is claimed by
 * `worker-api/poll.ts`, which never writes `dispatched_message_id` — only the
 * server dispatcher in `watchers/automation.ts` does. So an operator can set
 * `permission_mode` on a device Behavior, have it accepted and persisted, and
 * get no effect at all. That is the exact class of dead config this policy
 * exists to remove, so it is logged rather than swallowed until the device
 * poll records a per-turn correlation of its own.
 *
 * Costs a query only when the conversation really is a Behavior turn AND the
 * bind already failed — never on an ordinary chat turn.
 */
async function logUnattendedBindMiss(
	sql: DbClient,
	watcherId: number,
	behaviorRunId: number,
	scope: UnattendedRunScope,
): Promise<void> {
	const diagnostic = await sql`
    SELECT w.execution_config->>'permission_mode' AS permission_mode,
           w.device_worker_id IS NOT NULL AS device_pinned,
           behavior_run.status AS run_status,
           behavior_run.dispatched_message_id IS NULL AS never_dispatched
    FROM watchers w
    LEFT JOIN runs behavior_run
      ON behavior_run.id = ${behaviorRunId}
     AND behavior_run.watcher_id = w.id
    WHERE w.id = ${watcherId}
      AND w.organization_id = ${scope.organizationId}
    LIMIT 1
  `;
	const row = diagnostic[0];
	const mode = row?.permission_mode as string | null | undefined;
	if (mode == null || !UNATTENDED_PERMISSION_MODES.has(mode)) return;
	logger.warn(
		{
			behavior_id: watcherId,
			behavior_run_id: behaviorRunId,
			permission_mode: mode,
			device_pinned: row?.device_pinned === true,
			run_status: row?.run_status ?? null,
			never_dispatched_by_server: row?.never_dispatched !== false,
		},
		"[mcp] Behavior declares unattended execution but this turn is not its recorded server dispatch — requiring approval",
	);
}
