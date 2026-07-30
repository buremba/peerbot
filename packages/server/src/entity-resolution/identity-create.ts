import { getDb } from "../db/client";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";
import {
	createEntity,
	type CreatedEntity,
	type EntityData,
	getEntity,
} from "../utils/entity-management";
import { ToolUserError } from "../utils/errors";
import logger from "../utils/logger";
import {
	attachEntityIdentities,
	findEntitiesByIdentity,
	resolveIdentityOwner,
} from "./identity-lookup";
import type { ResolutionIdentity } from "./policy";

async function removeFreshEntity(
	entityId: number,
	organizationId: string,
): Promise<void> {
	const sql = getDb();
	await sql`
		DELETE FROM entities
		WHERE id = ${entityId}
		  AND organization_id = ${organizationId}
	`;
}

export async function createEntityWithIdentityClaims(input: {
	data: EntityData;
	identities: ResolutionIdentity[];
	env: Env;
	ctx: ToolContext;
	sourceConnector: string;
	/**
	 * Whether this caller may have a claim resolve to an EXISTING entity.
	 * Supplied by the tool layer (which owns the read-policy helpers) and must
	 * be type-level and data-independent: deciding per-resolved-entity would
	 * make create an oracle, since "denied" vs "created" would itself reveal
	 * that someone already claims this identifier.
	 */
	canResolveExisting: (entityTypeSlug: string) => Promise<boolean>;
}): Promise<{ entity: CreatedEntity; attachedToExisting: boolean }> {
	if (input.identities.length === 0) {
		return {
			entity: await createEntity(input.data, {
				hookContext: {
					organizationId: input.ctx.organizationId,
					userId: input.ctx.userId,
					env: input.env,
				},
			}),
			attachedToExisting: false,
		};
	}

	// Resolution hands back a PRE-EXISTING record, so it is only safe for a
	// caller allowed to read this type. The check is on the TYPE and runs BEFORE
	// any lookup on purpose: gating on the resolved entity instead would make
	// create an oracle, because "denied" vs "created" would itself reveal that
	// someone already claims this identifier. Denied callers fall through to a
	// plain create — exactly what this call did before this path existed.
	if (!(await input.canResolveExisting(input.data.entity_type))) {
		return {
			entity: await createUnresolvedEntity(input),
			attachedToExisting: false,
		};
	}

	const sql = getDb();
	const owners = await findEntitiesByIdentity(sql, {
		organizationId: input.ctx.organizationId,
		identities: input.identities,
	});
	const resolved = resolveIdentityOwner(owners, input.identities);
	if (resolved.decision === "ambiguous") {
		throw new ToolUserError(
			`These identifiers already belong to different entities (${resolved.candidateEntityIds.join(", ")}), so creating one entity for them would silently fuse separate records. Merge those entities first with manage_entity(action='merge'), or create with only the identifiers of one of them.`,
			409,
		);
	}
	if (resolved.decision === "attach" && resolved.entityId !== undefined) {
		const existing = await getEntity(resolved.entityId, input.env, input.ctx);
		if (!existing) {
			throw new ToolUserError(
				"Identity ownership changed while creating the entity; retry.",
				409,
			);
		}
		// The owner can be a DIFFERENT type than the one being created — a phone
		// claimed by a $member, say. Authorizing only the requested type would
		// hand back a record the caller may not read, so re-check against the
		// owner's ACTUAL type and fall through to the indistinguishable
		// unresolved-create path when denied.
		if (!(await input.canResolveExisting(existing.entity_type))) {
			return {
				entity: await createUnresolvedEntity(input),
				attachedToExisting: false,
			};
		}
		// This is still a create operation, not an update to the resolved record.
		// Its existing claims choose the entity; unclaimed inputs remain unchanged.
		return { entity: existing, attachedToExisting: true };
	}

	const entity = await createEntity(input.data, {
		hookContext: {
			organizationId: input.ctx.organizationId,
			userId: input.ctx.userId,
			env: input.env,
		},
	});
	try {
		const attached = await attachEntityIdentities(sql, {
			organizationId: input.ctx.organizationId,
			entityId: entity.id,
			identities: input.identities,
			sourceConnector: input.sourceConnector,
		});
		if (attached.length === input.identities.length) {
			return { entity, attachedToExisting: false };
		}
	} catch (error) {
		try {
			await removeFreshEntity(entity.id, input.ctx.organizationId);
		} catch (cleanupError) {
			logger.error(
				{ cleanupError, entityId: entity.id },
				"Failed to remove an entity after its identity claims failed",
			);
		}
		throw error;
	}

	// Another writer won at least one unique claim after our lookup. The fresh
	// row cannot survive without the full identity set; remove it and reconcile
	// to the owner selected by the unique index.
	await removeFreshEntity(entity.id, input.ctx.organizationId);
	const winnerOwners = await findEntitiesByIdentity(sql, {
		organizationId: input.ctx.organizationId,
		identities: input.identities,
	});
	const winner = resolveIdentityOwner(winnerOwners, input.identities);
	if (winner.decision === "attach" && winner.entityId !== undefined) {
		const existing = await getEntity(winner.entityId, input.env, input.ctx);
		if (existing) {
			if (!(await input.canResolveExisting(existing.entity_type))) {
				throw new ToolUserError(
					"Identity ownership changed while creating the entity; retry.",
					409,
				);
			}
			return { entity: existing, attachedToExisting: true };
		}
	}
	if (winner.decision === "ambiguous") {
		throw new ToolUserError(
			`These identifiers now belong to different entities (${winner.candidateEntityIds.join(", ")}); merge them before retrying.`,
			409,
		);
	}
	throw new ToolUserError(
		"Identity ownership changed while creating the entity; retry.",
		409,
	);
}

/**
 * Plain create for a caller who may not resolve against existing entities.
 * Claims attach best-effort: one already held by another entity stays with its
 * owner and simply does not attach here. Partial attachment is NOT treated as a
 * lost race, because reconciling would hand back the very entity this caller is
 * not allowed to see.
 */
async function createUnresolvedEntity(input: {
	data: EntityData;
	identities: ResolutionIdentity[];
	env: Env;
	ctx: ToolContext;
	sourceConnector: string;
}): Promise<CreatedEntity> {
	const entity = await createEntity(input.data, {
		hookContext: {
			organizationId: input.ctx.organizationId,
			userId: input.ctx.userId,
			env: input.env,
		},
	});
	if (input.identities.length === 0) return entity;
	try {
		await attachEntityIdentities(getDb(), {
			organizationId: input.ctx.organizationId,
			entityId: entity.id,
			identities: input.identities,
			sourceConnector: input.sourceConnector,
		});
	} catch (error) {
		try {
			await removeFreshEntity(entity.id, input.ctx.organizationId);
		} catch (cleanupError) {
			logger.error(
				{ cleanupError, entityId: entity.id },
				"Failed to remove an entity after its identity claims failed",
			);
		}
		throw error;
	}
	return entity;
}
