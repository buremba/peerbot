import { type DbClient, pgBigintArray } from '../db/client';

/** Per-Automation rolling window used by the health verdict. */
export const AUTOMATION_HEALTH_RUN_WINDOW = 100;

/**
 * Bound the request-path read to the newest global run-id range. `runs.id` is
 * the primary key, so this range is indexed without a schema change. The
 * per-Automation window below is smaller; this outer bound prevents an idle
 * Automation from making a list request search its unbounded lifetime.
 */
const AUTOMATION_HEALTH_GLOBAL_RUN_ID_SPAN = 100_000n;

interface RecentRunRow {
	automation_id: string;
	status: string;
}

/**
 * Load at most 100 recent scored terminal outcomes per requested Automation.
 *
 * The MATERIALIZED candidate set is bounded first by the indexed `runs.id`
 * range. Ranking therefore never walks or aggregates unbounded history, and
 * the result is capped at 100 rows per Automation for the JS classifier.
 * Cancelled runs are terminal lifecycle rows but carry no success/failure
 * outcome, so they are intentionally excluded from the health ratio.
 */
export async function loadRecentAutomationRunStatuses(
	sql: DbClient,
	automationIds: number[],
): Promise<Map<number, string[]>> {
	const ids = [...new Set(automationIds.filter(Number.isFinite).map(Math.trunc))];
	const statuses = new Map<number, string[]>();
	if (ids.length === 0) return statuses;

	const [head] = (await sql`
		SELECT COALESCE(MAX(id), 0)::text AS max_id FROM runs
	`) as unknown as Array<{ max_id: string }>;
	const maxId = BigInt(head?.max_id ?? '0');
	const minId =
		maxId > AUTOMATION_HEALTH_GLOBAL_RUN_ID_SPAN
			? maxId - AUTOMATION_HEALTH_GLOBAL_RUN_ID_SPAN
			: 0n;

	const rows = (await sql`
		WITH recent_global_runs AS MATERIALIZED (
			SELECT id, automation_id, status
			FROM runs
			WHERE id > ${minId.toString()}::bigint
			  AND id <= ${maxId.toString()}::bigint
			ORDER BY id DESC
		), ranked AS (
			SELECT
				automation_id,
				status,
				ROW_NUMBER() OVER (PARTITION BY automation_id ORDER BY id DESC) AS position
			FROM recent_global_runs
			WHERE automation_id = ANY(${pgBigintArray(ids)}::bigint[])
			  AND status IN ('completed', 'failed', 'timeout')
		)
		SELECT automation_id::text, status
		FROM ranked
		WHERE position <= ${AUTOMATION_HEALTH_RUN_WINDOW}
		ORDER BY automation_id, position
	`) as unknown as RecentRunRow[];

	for (const row of rows) {
		const automationId = Number(row.automation_id);
		const current = statuses.get(automationId);
		if (current) current.push(row.status);
		else statuses.set(automationId, [row.status]);
	}
	return statuses;
}
