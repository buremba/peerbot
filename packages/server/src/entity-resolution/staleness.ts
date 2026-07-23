import { type DbClient, pgBigintArray } from "../db/client";
import { loadLiveEntityIdentities } from "./identities";
import { assessEntityResolution } from "./policy";

/** Lock and re-evaluate a reviewed merge immediately before applying it. */
export async function assertResolutionFingerprintCurrent(
	db: DbClient,
	input: {
		organizationId: string;
		winnerId: number;
		loserIds: number[];
		expectedFingerprint: string;
	},
): Promise<void> {
	const ids = [...input.loserIds, input.winnerId].sort((a, b) => a - b);
	const rows = await db<{
		id: number;
		entity_type_id: number;
		metadata: Record<string, unknown>;
		metadata_schema: Record<string, unknown> | null;
		entity_type_slug: string;
	}>`
		SELECT entity.id, entity.entity_type_id, entity.metadata,
		       type.metadata_schema, type.slug AS entity_type_slug
		FROM entities entity
		JOIN entity_types type ON type.id = entity.entity_type_id
		WHERE entity.organization_id = ${input.organizationId}
		  AND entity.id = ANY(${pgBigintArray(ids)}::bigint[])
		  AND entity.deleted_at IS NULL
		ORDER BY entity.id
		FOR UPDATE OF entity
		FOR SHARE OF type
	`;
	if (rows.length !== ids.length) {
		throw new Error(
			"Merge evidence is stale because an entity is no longer live",
		);
	}
	if (new Set(rows.map((row) => Number(row.entity_type_id))).size !== 1) {
		throw new Error("Merge evidence is stale because entity types changed");
	}
	const byId = new Map(rows.map((row) => [Number(row.id), row]));
	const winner = byId.get(input.winnerId);
	if (!winner)
		throw new Error("Merge evidence is stale because the winner changed");
	const identities = await loadLiveEntityIdentities(db, {
		organizationId: input.organizationId,
		entityIds: ids,
		forUpdate: true,
	});
	const assessment = assessEntityResolution({
		metadataSchema: winner.metadata_schema,
		entityTypeSlug: winner.entity_type_slug,
		winner: {
			id: input.winnerId,
			metadata: winner.metadata ?? {},
			identities: identities.get(input.winnerId) ?? [],
		},
		losers: input.loserIds.map((loserId) => ({
			id: loserId,
			metadata: byId.get(loserId)?.metadata ?? {},
			identities: identities.get(loserId) ?? [],
		})),
	});
	if (assessment.fingerprint !== input.expectedFingerprint) {
		throw new Error(
			"Merge evidence or resolution policy changed after review was requested",
		);
	}
}
