/**
 * The run-lease vocabulary shared by every write that finalizes a run the
 * gateway itself is executing.
 *
 * A gateway request that executes a run inline claims it first
 * (`gateway-inline-<uuid>`) and holds that lease across the external call. The
 * writes below can therefore land long after the claim, by which time a
 * cancel, the stale-run reaper, or a second approve may have handed the run to
 * someone else. Every one of them fences on the owner so a late write cannot
 * overwrite whoever holds the run now.
 *
 * The fence values are REQUIRED parameters. An "omit it to skip the fence"
 * escape hatch is a fail-open guard dressed as a guard: the one caller that
 * forgets is exactly the one that clobbers another owner's run.
 */

import type { DbClient } from "../db/client";

/**
 * Reported when a fenced terminal write matches no row: the run was cancelled,
 * reaped, or re-claimed while this request was still executing. The external
 * call may well have succeeded, but this request no longer owns the run, so it
 * must not overwrite whoever does — the durable row is the answer.
 */
export const LOST_LEASE_MESSAGE =
	"Inline execution lost its run lease; the durable run state is authoritative.";

/**
 * The guard every inline terminal write shares: land the outcome only while
 * this request still owns the run it claimed and nothing has terminalized it.
 * One definition, because hand-written copies drift and a fence that silently
 * matches no row looks exactly like one that worked.
 */
export function inlineLeaseFence(sql: DbClient, claimedBy: string) {
	return sql`AND status = 'running' AND claimed_by = ${claimedBy}`;
}

/**
 * Fence a terminal write on the owner the caller READ, for recovery paths that
 * finalize a run they did not claim themselves. `null` is not "no fence": it
 * asserts the run is still unowned, which is what a run claimed before the
 * gateway took leases looks like. Either way the write loses to a concurrent
 * re-claim instead of overwriting it.
 */
export function runOwnerFence(sql: DbClient, expectedOwner: string | null) {
	return expectedOwner === null
		? sql`AND claimed_by IS NULL`
		: sql`AND claimed_by = ${expectedOwner}`;
}
