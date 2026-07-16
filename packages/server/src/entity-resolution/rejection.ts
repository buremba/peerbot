import type { DbClient } from "../db/client";

/**
 * A rejected deterministic candidate stays quiet until either its normalized
 * evidence or its entity-type policy changes. Both are encoded in the
 * resolution fingerprint, so no pod-local suppression state is involved.
 */
export async function wasResolutionRejected(
	db: DbClient,
	input: { organizationId: string; fingerprint: string },
): Promise<boolean> {
	const rows = await db`
		SELECT 1
		FROM runs
		WHERE organization_id = ${input.organizationId}
		  AND run_type = 'internal'
		  AND action_key = 'entity_change'
		  AND approval_status = 'rejected'
		  AND action_input->>'operation' = 'merge'
		  AND action_input->>'resolution_fingerprint' = ${input.fingerprint}
		LIMIT 1
	`;
	return rows.length > 0;
}
