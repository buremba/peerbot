/**
 * The run-lease vocabulary shared by every write that lands an outcome on a
 * run somebody else could have taken in the meantime.
 *
 * Two kinds of holder take a run lease, and both fence the same way:
 *  - the gateway executing a run inline, which claims it as
 *    `gateway-inline-<uuid>` and holds that across the external call;
 *  - a worker that claimed the run through `/poll`, which holds it across the
 *    whole execution and reports back over the worker API.
 *
 * Either way the write can land long after the claim, by which time a cancel,
 * the stale-run reaper, or a second claim may have handed the run to someone
 * else. Every one of them fences on the owner so a late write cannot overwrite
 * whoever holds the run now.
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
 * The guard every terminal write shares: land the outcome only while this
 * holder still owns the run it claimed and nothing has terminalized it.
 * One definition, because hand-written copies drift and a fence that silently
 * matches no row looks exactly like one that worked. This was nine identical
 * hand-written copies across the worker API, the automation completion path
 * and the inline gateway path before it was one function.
 */
export function runLeaseFence(sql: DbClient, claimedBy: string) {
	return sql`AND status = 'running' AND claimed_by = ${claimedBy}`;
}

/**
 * Fence a write on the owner ALONE, leaving the run's status out of it. Two
 * callers need that: recovery paths finalizing a run they did not claim
 * themselves, and non-terminal progress writes that must not care which
 * lifecycle state the run is in, only that it is still ours. `null` is not "no fence": it
 * asserts the run is still unowned, which is what a run claimed before the
 * gateway took leases looks like. Either way the write loses to a concurrent
 * re-claim instead of overwriting it.
 */
export function runOwnerFence(sql: DbClient, expectedOwner: string | null) {
	return expectedOwner === null
		? sql`AND claimed_by IS NULL`
		: sql`AND claimed_by = ${expectedOwner}`;
}
