import type { DbClient } from "../db/client";

/** Serialize decisions for one entity group across pods and evidence versions. */
export async function lockResolutionCandidate(
	db: DbClient,
	input: { organizationId: string; winnerId: number; loserIds: number[] },
): Promise<void> {
	const entityIds = [...new Set([input.winnerId, ...input.loserIds])].sort(
		(left, right) => left - right,
	);
	await db`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`${input.organizationId}:${entityIds.join(",")}`}, 0)
		)
	`;
}

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
