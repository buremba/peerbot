/**
 * Does THIS run authorize unattended (uncarded) write-tool use?
 *
 * A scheduled Behavior has no human in the loop, so the MCP approval card the
 * gate emits can never be answered — the run just burns its turn and fails.
 * `execution_config.permission_mode` is the operator's declaration that a
 * Behavior is meant to run that way. Until this module existed the field was
 * validated, role-gated, persisted, and read by nobody, so the only way to
 * unblock a Behavior was a standing `mcp_tool` grant covering every call the
 * agent makes anywhere — much broader than the Behavior the operator actually
 * meant to trust.
 */

import { type DbClient, getDb } from "../../db/client.js";
import { UNATTENDED_PERMISSION_MODES } from "../../tools/admin/behavior-execution-config.js";
import logger from "../../utils/logger.js";

/**
 * True when `runId` belongs to a Behavior run whose Behavior is configured for
 * unattended execution.
 *
 * Scoping falls out of the query rather than a separate guard, which is why
 * there is no "is this headless?" check to keep in sync:
 * - no `runId` (an interactive browser/chat turn) → no row → false. A human is
 *   present to answer the card, so the bypass must not apply.
 * - a run with no `watcher_id` (chat, sync, task) → the join drops it → false.
 * - a Behavior run → the bypass is read from THAT Behavior only, so an elevated
 *   Behavior cannot lend its bypass to a sibling run of the same agent.
 *
 * Fails CLOSED. Any error returns false, which means "ask for approval" — the
 * same outcome as before this policy existed. An unreadable config must never
 * widen access.
 */
export async function runAllowsUnattendedToolUse(
	runId: number | null | undefined,
	db?: DbClient,
): Promise<boolean> {
	if (runId == null) return false;

	try {
		const sql = db ?? getDb();
		const rows = await sql`
      SELECT w.execution_config->>'permission_mode' AS permission_mode
      FROM runs r
      JOIN watchers w ON w.id = r.watcher_id
      WHERE r.id = ${runId}
      LIMIT 1
    `;
		const mode = rows[0]?.permission_mode as string | null | undefined;
		return mode != null && UNATTENDED_PERMISSION_MODES.has(mode);
	} catch (error) {
		logger.warn(
			{ error, run_id: runId },
			"[mcp] Could not read a Behavior's permission_mode — requiring tool approval",
		);
		return false;
	}
}
