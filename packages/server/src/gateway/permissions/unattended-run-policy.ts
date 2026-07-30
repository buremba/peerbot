/**
 * Does this agent turn belong to a Behavior its operator declared unattended?
 *
 * A scheduled Behavior has no human in the loop, so the MCP approval card the
 * gate emits can never be answered — the run just burns its turn and fails.
 * `execution_config.permission_mode` is the operator's Behavior-scoped
 * declaration that the turn may proceed without one. Until this module existed
 * the field was validated, role-gated, persisted, shipped to the worker, and
 * read by nobody, so the only way to unblock a Behavior was a standing
 * `mcp_tool` grant covering every call that agent makes anywhere — far broader
 * than the one Behavior the operator meant to trust.
 *
 * WHY conversationId AND NOT `tokenData.runId`: the token's `runId` is the
 * `chat_message` QUEUE row that dispatched the turn, not the parent `behavior`
 * row — `buildRunJobToken` stamps `data.runId` from the queue payload. Joining
 * `runs.watcher_id` on it therefore matches nothing in production. The Behavior
 * identity travels in the signed `conversationId` instead, whose suffix the
 * gateway builds as `_watcher_<watcherId>_run_<behaviorRunId>`. That is the
 * same correlation `listPendingToolsForRun` uses; keep the two in step.
 *
 * WHAT MAKES THAT SUFFIX TRUSTWORTHY, and it is not the signature: the token is
 * encrypted, so claims cannot be tampered with AFTER minting, but the gateway
 * mints them from the request body. The suffix is sound because
 * `POST /api/v1/agents` verifies a `behavior_run` intent against server-authored
 * dispatch state and reserves the internal `watcher_<id>` userId prefix — see
 * `./behavior-run-intent.ts`, which owns that invariant and states its residual.
 * If that check is ever weakened, this policy is caller-controlled again.
 */

import { type DbClient, getDb } from "../../db/client.js";
import { UNATTENDED_PERMISSION_MODES } from "../../tools/admin/behavior-execution-config.js";
import logger from "../../utils/logger.js";

/** Trailing `_watcher_<watcherId>_run_<behaviorRunId>` of a Behavior turn. */
const BEHAVIOR_CONVERSATION_SUFFIX = /_watcher_(\d+)_run_(\d+)$/;

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
 * Every identifier here comes from the signed token, and the query re-checks
 * ownership rather than trusting the parse: the Behavior named by the
 * conversation must live in the token's org AND belong to the token's agent,
 * and the named run must belong to that Behavior. So a turn cannot borrow the
 * elevated mode of another org's, another agent's, or a sibling Behavior — the
 * three ways this could otherwise become a privilege escalation.
 *
 * An interactive browser/chat turn has no `_watcher_…_run_…` conversation, so
 * it never matches and always gets the card. That is the scoping, and it needs
 * no separate "is this headless?" flag to stay in sync.
 *
 * Fails CLOSED. Any error returns false — "ask for approval", the same outcome
 * as before this policy existed. An unreadable config must never widen access.
 */
export async function runAllowsUnattendedToolUse(
	scope: UnattendedRunScope,
	db?: DbClient,
): Promise<boolean> {
	if (!scope.conversationId || !scope.organizationId || !scope.agentId) {
		return false;
	}
	const match = BEHAVIOR_CONVERSATION_SUFFIX.exec(scope.conversationId);
	if (!match) return false;
	const watcherId = Number(match[1]);
	const behaviorRunId = Number(match[2]);
	if (!Number.isSafeInteger(watcherId) || !Number.isSafeInteger(behaviorRunId)) {
		return false;
	}

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
