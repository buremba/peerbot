import type { DbClient, DbQuery } from "../db/client";
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from "../utils/run-statuses";
import { AUTOMATION_RUN_TYPES_PG } from "./run-types";

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
 * rows instead of orphaning one under a terminal parent.
 */
export function parentRunGate(
	sql: DbClient,
	params: {
		parentRunId: number | null;
		organizationId: string;
		/**
		 * An extra `OR (…)` branch widening what counts as an eligible parent.
		 * Interpolated inside `parent_gate`'s WHERE, so it may reference `runs`.
		 */
		alsoEligible?: DbQuery;
	},
): DbQuery {
	return sql`
		WITH parent_gate AS MATERIALIZED (
			SELECT id
			FROM runs
			WHERE id = ${params.parentRunId}
			  AND organization_id = ${params.organizationId}
			  AND (
			    (
			      run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
			      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
			    )
			    ${params.alsoEligible ?? sql``}
			  )
			FOR SHARE
		), authorized_parent AS (
			SELECT 1 WHERE ${params.parentRunId}::bigint IS NULL
			UNION ALL SELECT 1 FROM parent_gate
		)
	`;
}
