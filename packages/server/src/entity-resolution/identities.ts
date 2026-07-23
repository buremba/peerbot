import { type DbClient, pgBigintArray } from "../db/client";
import type { ResolutionIdentity } from "./policy";

/**
 * Load the live `entity_identities` rows the resolution policy resolves rule
 * fields against, keyed by entity id. All namespaces are loaded — custom
 * `exact` rules may key on custom namespaces, and the per-field namespace
 * filter lives in the policy itself.
 */
export async function loadLiveEntityIdentities(
	db: DbClient,
	input: { organizationId: string; entityIds: number[] },
): Promise<Map<number, ResolutionIdentity[]>> {
	const identities = new Map<number, ResolutionIdentity[]>();
	if (input.entityIds.length === 0) return identities;
	const rows = await db<{
		entity_id: number;
		namespace: string;
		identifier: string;
	}>`
		SELECT entity_id, namespace, identifier
		FROM entity_identities
		WHERE organization_id = ${input.organizationId}
		  AND entity_id = ANY(${pgBigintArray(input.entityIds)}::bigint[])
		  AND deleted_at IS NULL
	`;
	for (const row of rows) {
		const entityId = Number(row.entity_id);
		const bucket = identities.get(entityId) ?? [];
		bucket.push({ namespace: row.namespace, identifier: row.identifier });
		identities.set(entityId, bucket);
	}
	return identities;
}
