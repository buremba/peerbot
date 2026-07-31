import { type DbClient, pgBigintArray } from "../db/client";
import { loadLiveEntityIdentities } from "./identities";
import {
	assessEntityResolution,
	type EntityResolutionAssessment,
	RESOLUTION_FINGERPRINT_VERSION,
} from "./policy";

/**
 * Why a reviewed merge could not be applied against its stored fingerprint.
 *
 * `changed` means the workspace moved under the reviewer: same hash inputs,
 * different values. The proposal is genuinely stale.
 *
 * `incomparable` means the stored digest has no known current version, so it
 * cannot be compared at all. Nothing about the entities necessarily changed —
 * treating this as staleness makes the proposal permanently unapprovable,
 * because every retry recomputes the same mismatch.
 */
type ResolutionFingerprintFailure = "changed" | "incomparable";

export class ResolutionFingerprintError extends Error {
	readonly failure: ResolutionFingerprintFailure;
	/** The freshly computed assessment, so a caller can refresh without redoing the work. */
	readonly assessment: EntityResolutionAssessment;

	constructor(
		failure: ResolutionFingerprintFailure,
		assessment: EntityResolutionAssessment,
	) {
		super(
			failure === "incomparable"
				? "Merge evidence was recorded without a known current resolution format"
				: "Merge evidence or resolution policy changed after review was requested",
		);
		this.name = "ResolutionFingerprintError";
		this.failure = failure;
		this.assessment = assessment;
	}
}

/** Lock and re-evaluate a reviewed merge immediately before applying it. */
export async function assertResolutionFingerprintCurrent(
	db: DbClient,
	input: {
		organizationId: string;
		winnerId: number;
		loserIds: number[];
		expectedFingerprint: string;
		/**
		 * Which format produced `expectedFingerprint`. Required, and deliberately
		 * without a default: a live fingerprint computed in this process is current
		 * by construction, while an unstamped stored proposal has unknown provenance.
		 * Guessing a version could silently accept incomparable evidence.
		 */
		expectedVersion: number | null;
	},
): Promise<EntityResolutionAssessment> {
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
	// A newer stamp must fail closed during a rolling deploy rather than being
	// downgraded by an older replica.
	if (
		input.expectedVersion !== null &&
		input.expectedVersion > RESOLUTION_FINGERPRINT_VERSION
	) {
		throw new Error(
			"Merge evidence was recorded under a newer resolution format and cannot be verified by this server",
		);
	}
	// Exact equality is safe even for an unstamped or older proposal. The version
	// is needed only to interpret a mismatch: missing/older inputs are
	// incomparable, while a current-version mismatch proves drift.
	if (assessment.fingerprint === input.expectedFingerprint) return assessment;
	if (
		input.expectedVersion === null ||
		input.expectedVersion < RESOLUTION_FINGERPRINT_VERSION
	) {
		throw new ResolutionFingerprintError("incomparable", assessment);
	}
	throw new ResolutionFingerprintError("changed", assessment);
}
