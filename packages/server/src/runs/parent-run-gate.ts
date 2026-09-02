import type { DbClient, DbQuery } from "../db/client";
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from "../utils/run-statuses";
import { AUTOMATION_RUN_TYPES_PG } from "./run-types";

/** What a caller has to say to identify the parent it wants to write under. */
export type ParentRunGateParams = {
	parentRunId: number | null;
	organizationId: string;
	/**
	 * An extra `OR (…)` branch widening what counts as an eligible parent.
	 * Interpolated inside the predicate, so it may reference `runs` columns.
	 */
	alsoEligible?: DbQuery;
};

/**
 * Is this `runs` row a parent a child may still be written under?
 *
 * One predicate, so the `FOR SHARE` pre-check a caller takes for lock ordering
 * and the gate guarding its INSERT cannot disagree about what "still active"
 * means.
 */
function eligibleParent(sql: DbClient, params: ParentRunGateParams): DbQuery {
	return sql`
		id = ${params.parentRunId}
		AND organization_id = ${params.organizationId}
		AND (
		  (
		    run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
		    AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
		  )
		  ${params.alsoEligible ?? sql``}
		)
	`;
}

/**
 * Take the declared parent `FOR SHARE`, returning no row if it is not eligible.
 *
 * For callers that must hold the parent before some other lock — the proposal
 * writers take it ahead of their advisory idempotency lock, matching the order
 * `complete_window` already uses, so the two cannot deadlock.
 */
export function selectEligibleParent(
	sql: DbClient,
	params: ParentRunGateParams,
): DbQuery<{ id: number }> {
	return sql<{ id: number }>`
		SELECT id FROM runs WHERE ${eligibleParent(sql, params)} FOR SHARE
	`;
}

/**
 * The `WITH …` prelude that makes writing a child run conditional on its
 * declared parent still being alive.
 *
 * Every path that inserts a run on behalf of a running Automation has to answer
 * the same question first: does the declared parent still exist, in this org,
 * in a state that can still consume a child? `parent_gate` takes `FOR SHARE` so
 * the parent cannot terminalize between that check and the INSERT, and
 * `authorized_parent` turns "no parent declared" into an unconditional pass.
 *
 * Callers interpolate this at the head of an INSERT and select
 * `FROM authorized_parent LIMIT 1`, so an insert whose parent died writes zero
 * rows instead of orphaning one under a terminal parent. Turn that empty result
 * into `parentRunNoLongerActive`.
 */
export function parentRunGate(
	sql: DbClient,
	params: ParentRunGateParams,
): DbQuery {
	return sql`
		WITH parent_gate AS MATERIALIZED (
			SELECT id FROM runs WHERE ${eligibleParent(sql, params)} FOR SHARE
		), authorized_parent AS (
			SELECT 1 WHERE ${params.parentRunId}::bigint IS NULL
			UNION ALL SELECT 1 FROM parent_gate
		)
	`;
}

/**
 * The failure a gated write reports when its parent was not eligible.
 *
 * The gate declines by writing nothing, so every caller has to turn an empty
 * result into the same error; keeping the wording here is what stops six paths
 * from drifting into six phrasings of one condition.
 */
export function parentRunNoLongerActive(parentRunId: number | null): Error {
	return new Error(`Automation parent run ${parentRunId} is no longer active.`);
}
