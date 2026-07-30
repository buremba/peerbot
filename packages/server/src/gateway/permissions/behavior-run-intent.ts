/**
 * Server-side verification of a `behavior_run` session intent.
 *
 * `POST /api/v1/agents` accepts `intent: {kind:"behavior_run", runId, behaviorId}`
 * from the request body, and the route turns it into
 * `userId = watcher_<behaviorId>` / `thread = run_<runId>`, hence a
 * `conversationId` ending `_watcher_<behaviorId>_run_<runId>`. That suffix is
 * the correlation the worker token carries, and downstream consumers — the MCP
 * tool-approval gate among them — read a Behavior's identity out of it.
 *
 * Without this check the whole chain is caller-authored: the token is
 * encrypted, so its claims cannot be tampered with AFTER minting, but the
 * gateway minted them from the request body, so the signature attests
 * transport integrity, not provenance. Verifying here — the one place the
 * intent enters the system — is what makes every downstream reading of that
 * suffix sound. Do not re-derive provenance further down; derive it once, here.
 *
 * The verification leans on state only the server can author. Behavior dispatch
 * (`dispatchWatcherRun`) claims the run through `claimPendingWatcherRun` —
 * stamping `status='claimed'` and `claimed_by='lobu-dispatcher'` — BEFORE it
 * calls this route, and flips it to `running` immediately after. No API caller
 * can put a run into that state.
 *
 * Residual, stated plainly: while a legitimate run of Behavior B is in flight,
 * a member of the same org operating the same agent could name it and inherit
 * B's session shape for that window. Closing that needs a distinguishable
 * service principal at this route (the internal dispatcher token currently
 * authenticates as an ordinary org owner/admin, and the middleware surfaces
 * only `userId`/`organizationId`), which is a bigger change than this gate
 * warrants. What is closed is the unbounded case: naming any Behavior at any
 * time, including one that has never run.
 */

import { type DbClient, getDb } from "../../db/client.js";
import logger from "../../utils/logger.js";

/**
 * `claimPendingWatcherRun`'s `claimedBy` for the server-side Behavior
 * dispatcher. Device-pinned Behaviors are claimed by their worker instead and
 * do not take this route.
 */
const SERVER_DISPATCHER = "lobu-dispatcher";

/**
 * Reserved internal `userId` shape. The route builds `watcher_<behaviorId>`
 * itself for a verified intent, so a request body may never supply one: that
 * would let a caller assemble the Behavior conversation suffix WITHOUT an
 * intent and bypass the verification below entirely.
 */
const RESERVED_INTERNAL_USER_ID = /^watcher_\d+$/;

export function isReservedInternalUserId(userId: string | undefined): boolean {
	return typeof userId === "string" && RESERVED_INTERNAL_USER_ID.test(userId);
}

export interface BehaviorRunIntent {
	runId: number;
	behaviorId: number;
}

/**
 * True when `intent` names a real Behavior run that the server itself has
 * dispatched, in the caller's own organization.
 *
 * Fails CLOSED: an unreadable database, a missing run, a run belonging to
 * another Behavior or another tenant, and a run in any state the dispatcher did
 * not put it in all return false.
 */
export async function verifyBehaviorRunIntent(
	args: {
		intent: BehaviorRunIntent;
		organizationId: string | undefined;
	},
	db?: DbClient,
): Promise<boolean> {
	if (!args.organizationId) return false;
	const { runId, behaviorId } = args.intent;
	if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(behaviorId)) {
		return false;
	}
	try {
		const sql = db ?? getDb();
		const rows = await sql`
      SELECT 1
      FROM runs
      WHERE id = ${runId}
        AND run_type = 'behavior'
        AND watcher_id = ${behaviorId}
        AND organization_id = ${args.organizationId}
        AND claimed_by = ${SERVER_DISPATCHER}
        AND status IN ('claimed', 'running')
      LIMIT 1
    `;
		return rows.length > 0;
	} catch (error) {
		logger.warn(
			{ error, runId, behaviorId, organizationId: args.organizationId },
			"[agent] Could not verify a Behavior run intent — refusing the session",
		);
		return false;
	}
}
