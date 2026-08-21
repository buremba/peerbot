import { type DbClient, pgBigintArray } from '../db/client';

export const AUTOMATION_HEALTH_RUN_WINDOW = 100;

interface RecentRunRow {
	automation_id: string;
	status: string;
}

/**
 * Use idx_runs_automation_id to load at most 100 scored terminal outcomes for
 * each requested Automation. Aggregate only after each per-ID read is bounded.
 */
export async function loadRecentAutomationRunStatuses(
	sql: DbClient,
	automationIds: number[],
): Promise<Map<number, string[]>> {
	const ids = [...new Set(automationIds.filter(Number.isFinite).map(Math.trunc))];
	const statuses = new Map<number, string[]>();
	if (ids.length === 0) return statuses;

	const rows = (await sql`
		SELECT requested.id::text AS automation_id, recent.status
		FROM unnest(${pgBigintArray(ids)}::bigint[]) AS requested(id)
		CROSS JOIN LATERAL (
			SELECT r.id, r.status
			FROM runs r
			WHERE r.automation_id = requested.id
			  AND r.run_type = 'automation'
			  AND r.status IN ('completed', 'failed', 'timeout')
			ORDER BY r.id DESC
			LIMIT ${AUTOMATION_HEALTH_RUN_WINDOW}
		) AS recent
		ORDER BY requested.id, recent.id DESC
	`) as unknown as RecentRunRow[];

	for (const row of rows) {
		const automationId = Number(row.automation_id);
		const current = statuses.get(automationId);
		if (current) current.push(row.status);
		else statuses.set(automationId, [row.status]);
	}
	return statuses;
}
