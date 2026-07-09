/**
 * Tool: manage_entity
 *
 * Entity management - create, update, list, get, delete.
 * Also manages entity relationships (graph edges between entities).
 *
 * Actions:
 * - create: Create new entity
 * - update: Update existing entity
 * - list: List entities with filtering
 * - get: Get details for specific entity
 * - delete: Delete entity (with optional force for cascading deletes)
 * - link: Create a relationship between two entities
 * - unlink: Soft-delete a relationship
 * - update_link: Update metadata/confidence/source on a relationship
 * - list_links: List relationships for an entity with filters
 */

import {
	type ManageEntityArgs,
	type ManageEntityResult,
	ManageEntityResultSchema,
	ManageEntitySchema,
	type RelationshipCountByType,
	type RelationshipRow,
} from "@lobu/core/contracts/tools/manage-entity";
import {
	classifyMutationPrincipal,
	mutationPrincipalId,
	type EntityPolicyPrincipalKind,
} from "../../authz/entity-policy";
import { runMutationGate } from "../../authz/entity-mutation-gate";
import { getDb, pgTextArray } from "../../db/client";
import type { Env } from "../../index";
import {
	batchLoadRelationships,
	createEntity,
	deleteEntity,
	type EntityData,
	getEntity,
	listEntities,
	type RelationshipColumnSpec,
	updateEntity,
} from "../../utils/entity-management";
import { applyMerge, applyUnmerge } from "../../utils/entity-merge";
import { ToolUserError } from "../../utils/errors";
import { recordChangeEvent } from "../../utils/insert-event";
import { resolveMemberSchemaFieldsFromSchema } from "../../utils/member-entity-type";
import {
	canonicalizeSymmetricEdge,
	checkDuplicateEdge,
	validateConfidence,
	validateNoSelfReference,
	validateScopeRule,
	validateSource,
	validateTypeRule,
} from "../../utils/relationship-validation";
import { validateEntityMetadata } from "../../utils/schema-validation";
import { buildEntityUrl } from "../../utils/url-builder";
import { trackWatcherReaction } from "../../utils/watcher-reactions";
import { isAdminOrOwnerRole } from "../access-control";
import { MEMBER_ENTITY_TYPE_SLUG } from "../constants";
import type { ToolContext } from "../registry";
import { withValidatedArgs } from "../validate-args";
import {
	buildEntityViewUrl,
	getOrgUrlContext,
	toEntityInfo,
} from "../view-urls";
import { defineFlatActionTool, flatAction } from "./action-tool";

export { ManageEntityResultSchema, ManageEntitySchema };

function toIsoStringOrNow(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function principalKindForMutation(
	args: ManageEntityArgs,
	ctx: ToolContext,
): EntityPolicyPrincipalKind {
	return classifyMutationPrincipal({
		userId: ctx.userId,
		agentId: ctx.agentId,
		watcherSource: args.watcher_source,
	});
}

// ============================================
// Main Function (Action Router)
// ============================================

const runManageEntity = defineFlatActionTool<
	ManageEntityArgs,
	ManageEntityResult
>("manage_entity", {
	create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
	update: flatAction(
		(args, ctx, env) => handleUpdate(args.entity_id!, args, env, ctx),
		{
			requires: ["entity_id"],
		},
	),
	list: flatAction((args, ctx, env) => handleList(args, env, ctx)),
	get: flatAction((args, ctx, env) => handleGet(args.entity_id!, env, ctx), {
		requires: ["entity_id"],
	}),
	delete: flatAction(
		(args, ctx, env) =>
			handleDelete(
				args.entity_id!,
				args.force_delete_tree ?? false,
				env,
				ctx,
				args,
			),
		{ requires: ["entity_id"] },
	),
	link: flatAction((args, ctx, env) => handleLink(args, env, ctx)),
	unlink: flatAction(handleUnlink),
	update_link: flatAction(handleUpdateLink),
	list_links: flatAction(handleListLinks),
	merge: flatAction((args, ctx) => handleMerge(args, ctx), {
		requires: ["entity_id", "winner_entity_id"],
	}),
	unmerge: flatAction((args, ctx) => handleUnmerge(args, ctx), {
		requires: ["entity_id"],
	}),
});

export const manageEntity = withValidatedArgs(
	"manage_entity",
	ManageEntitySchema,
	manageEntityImpl,
);

async function manageEntityImpl(
	args: ManageEntityArgs,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
  const result = await runManageEntity(args, env, ctx);

  // Track watcher reaction for mutating actions
  if (args.watcher_source && 'action' in result) {
    const reactionType =
      result.action === 'create'
        ? 'entity_created'
        : result.action === 'update'
          ? 'entity_updated'
          : result.action === 'link'
            ? 'entity_linked'
            : null;
    if (reactionType) {
      const entityId =
        result.action === 'create' && 'entity' in result
          ? (result as any).entity.id
          : args.entity_id;
      await trackWatcherReaction({
        organizationId: ctx.organizationId,
        watcherId: args.watcher_source.watcher_id,
        windowId: args.watcher_source.window_id,
        reactionType,
        toolName: 'manage_entity',
        toolArgs: {
          action: args.action,
          entity_type: args.entity_type,
          name: args.name,
          entity_id: args.entity_id,
        },
        toolResult: result as Record<string, unknown>,
        entityId,
      });
    }
  }

  return result;
}

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
	args: ManageEntityArgs,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!args.entity_type) {
		throw new Error("entity_type is required for create action");
	}

	if (!args.name) {
		throw new Error("name is required for create action");
	}

	// (Derived-type rejection lives in createEntity — the single chokepoint that
	// also resolves public-catalog types.)

	// Validate metadata against entity type's JSON schema (if defined)
	if (args.metadata && Object.keys(args.metadata).length > 0) {
		const validation = await validateEntityMetadata(
			args.entity_type,
			args.metadata,
			ctx,
		);
		if (!validation.valid) {
			const errorMessages =
				validation.errors?.map((e) => e.message).join("; ") ??
				"Invalid metadata";
			throw new Error(`Metadata validation failed: ${errorMessages}`);
		}
	}

	// Build entity data with organization_id from context
	const entityData: EntityData = {
		entity_type: args.entity_type,
		name: args.name,
		slug: args.slug,
		parent_id: args.parent_id ?? null,
		metadata: args.metadata ?? {},
		enabled_classifiers: args.enabled_classifiers ?? null,
		organization_id: ctx.organizationId,
	};
	(entityData as any).created_by = ctx.userId ?? "system";

	// All fields available on all entity types - DB constraints handle validation
	entityData.domain = args.domain ?? null;
	entityData.category = args.category ?? null;
	entityData.platform_type = args.platform_type ?? null;
	entityData.main_market = args.main_market ?? null;
	entityData.market = args.market ?? null;
	entityData.link = args.link ?? null;

	// Content body (used by memory entities)
	if (args.content !== undefined) {
		entityData.content = args.content;
	}

	const proposal = {
		entity_type: entityData.entity_type,
		name: entityData.name,
		parent_id: entityData.parent_id ?? null,
		metadata: entityData.metadata ?? {},
	};
	const attribution: "agent" | "watcher" = args.watcher_source
		? "watcher"
		: "agent";
	const createDecision = await runMutationGate({
		action: "create",
		organizationId: ctx.organizationId,
		principalKind: principalKindForMutation(args, ctx),
		sql: getDb(),
		attribution,
		watcherId: args.watcher_source?.watcher_id ?? null,
		windowId: args.watcher_source?.window_id ?? null,
		principalId: mutationPrincipalId({
			agentId: ctx.agentId,
			watcherId: args.watcher_source?.watcher_id ?? null,
		}),
		entityTypeSlug: args.entity_type,
		entityData,
		proposal,
	});
	if (createDecision.outcome === "deny") {
		throw new ToolUserError(createDecision.reason, 403);
	}
	if (createDecision.outcome === "defer") {
		const res = await createDecision.deferred.queue(ctx, env);
		return {
			action: "create",
			approval_queued: true,
			approval_url: res.approvalUrl,
			approval_run_id: res.runId,
			approval_action: "create",
			approval_proposal: proposal,
			approval_current: {},
			approval_attribution: attribution,
			next_steps: [
				`${capitalize(args.entity_type)} "${args.name}" is waiting for approval before it is created.`,
			],
		} as unknown as ManageEntityResult;
	}

	const entity = await createEntity(entityData, {
		hookContext: {
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			env,
		},
	});

	const entityTypeLabel = capitalize(entity.entity_type);

	// Build next steps
	const nextSteps: string[] = [
		`${entityTypeLabel} "${entity.name}" created successfully with ID ${entity.id}.`,
	];

	if (!entity.parent_id) {
		// Root entity (no parent)
		nextSteps.push(
			`Use manage_connections(action='create') to install a connector, then manage_feeds(action='create_feed', entity_ids=[${entity.id}]) to target this entity.`,
			`Use manage_watchers(action='create', entity_id=${entity.id}) to schedule watchers.`,
		);
	} else {
		// Child entity (has parent)
		nextSteps.push(
			`${entityTypeLabel} belongs to ${entity.parent_name ? `"${entity.parent_name}"` : "parent"} (ID: ${entity.parent_id}).`,
			`Use manage_connections(action='create') to install a connector, then manage_feeds(action='create_feed', entity_ids=[${entity.id}]) to target this entity.`,
		);
	}

	const entityDetails = (await getEntity(entity.id, env, ctx)) ?? entity;
	const createdAtIso = toIsoStringOrNow(entityDetails.created_at);
	const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

	return {
		action: "create",
		entity: {
			id: entityDetails.id,
			entity_type: entityDetails.entity_type,
			name: entityDetails.name,
			slug: entityDetails.slug,
			parent_id: entityDetails.parent_id,
			parent_name: entityDetails.parent_name,
			parent_slug: entityDetails.parent_slug ?? null,
			metadata: entityDetails.metadata ?? {},
			enabled_classifiers: entityDetails.enabled_classifiers,
			created_at: createdAtIso,
			view_url: viewUrl,
		},
		warnings: entity.warnings,
		next_steps: nextSteps,
	};
}

async function handleUpdate(
	entityId: number,
	args: ManageEntityArgs,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
  const sql = getDb();

  // Fetch before state for change tracking and validation
  const beforeRows = await sql`
    SELECT e.name, e.slug, e.parent_id, e.metadata, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId} AND e.deleted_at IS NULL
  `;
	if (beforeRows.length === 0) {
		throw new Error(`Entity with ID ${entityId} not found`);
	}
	const before = beforeRows[0];

	// Validate metadata against entity type's JSON schema (if being updated)
	if (args.metadata !== undefined && Object.keys(args.metadata).length > 0) {
		const validation = await validateEntityMetadata(
			before.entity_type as string,
			args.metadata,
			ctx,
		);
		if (!validation.valid) {
			const errorMessages =
				validation.errors?.map((e) => e.message).join("; ") ??
				"Invalid metadata";
			throw new Error(`Metadata validation failed: ${errorMessages}`);
		}
	}

	// Build update data (only include fields that are present)
	const updateData: Partial<EntityData> = {};

	if (args.name !== undefined) updateData.name = args.name;
	if (args.slug !== undefined) updateData.slug = args.slug;
	if (args.parent_id !== undefined) updateData.parent_id = args.parent_id;
	if (args.enabled_classifiers !== undefined)
		updateData.enabled_classifiers = args.enabled_classifiers;

	// Type-specific fields
	if (args.domain !== undefined) updateData.domain = args.domain;
	if (args.category !== undefined) updateData.category = args.category;
	if (args.platform_type !== undefined)
		updateData.platform_type = args.platform_type;
	if (args.main_market !== undefined) updateData.main_market = args.main_market;
	if (args.market !== undefined) updateData.market = args.market;
	if (args.link !== undefined) updateData.link = args.link;

	// Content body
	if (args.content !== undefined) updateData.content = args.content;

	// Metadata (replaces entire object)
	if (args.metadata !== undefined) updateData.metadata = args.metadata;

	// Human-correction note: annotates the field_controls marker for the fields
	// this edit claims (why the human set/overrode the value).
	if (args.field_note !== undefined) updateData.field_note = args.field_note;

	// Approve/affirm: claim ownership of these fields' current values as-is.
	if (args.affirm_fields !== undefined)
		updateData.affirm_fields = args.affirm_fields;

	const updatedEntity = await updateEntity(entityId, updateData, env, ctx, {
		policyPrincipalKind: principalKindForMutation(args, ctx),
		attribution: args.watcher_source ? "watcher" : "agent",
		watcherId: args.watcher_source?.watcher_id ?? null,
		windowId: args.watcher_source?.window_id ?? null,
	});
	const entityDetails =
		(await getEntity(updatedEntity.id, env, ctx)) ?? updatedEntity;

	// Record field changes as a system event
	const beforeMetadata =
		typeof before.metadata === "string"
			? JSON.parse(before.metadata as string)
			: (before.metadata ?? {});
	const afterMetadata =
		typeof entityDetails.metadata === "string"
			? JSON.parse(entityDetails.metadata as string)
			: (entityDetails.metadata ?? {});

	const changes: Array<{ field: string; old: unknown; new: unknown }> = [];

	if (before.name !== entityDetails.name) {
		changes.push({ field: "name", old: before.name, new: entityDetails.name });
	}
	if (before.slug !== entityDetails.slug) {
		changes.push({ field: "slug", old: before.slug, new: entityDetails.slug });
	}
	const beforeParentId =
		before.parent_id != null ? Number(before.parent_id) : null;
	const afterParentId = entityDetails.parent_id ?? null;
	if (beforeParentId !== afterParentId) {
		changes.push({
			field: "parent_id",
			old: beforeParentId,
			new: afterParentId,
		});
	}
	if (args.content !== undefined) {
		changes.push({ field: "content", old: "[changed]", new: "[changed]" });
	}

	// Diff metadata keys (includes convenience fields like domain, category, etc.)
	const allMetadataKeys = new Set([
		...Object.keys(beforeMetadata),
		...Object.keys(afterMetadata),
	]);
	for (const key of allMetadataKeys) {
		if (
			JSON.stringify(beforeMetadata[key]) !== JSON.stringify(afterMetadata[key])
		) {
			changes.push({
				field: key,
				old: beforeMetadata[key] ?? null,
				new: afterMetadata[key] ?? null,
			});
		}
	}

	if (changes.length > 0) {
		const contentLines = changes.map(
			(c) =>
				`- ${c.field}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`,
		);

		recordChangeEvent({
			entityIds: [entityId],
			organizationId: ctx.organizationId,
			title: `Entity updated: ${changes.map((c) => c.field).join(", ")}`,
			content: `Entity "${entityDetails.name}" (id: ${entityId}) updated:\n${contentLines.join("\n")}`,
			metadata: { changes },
			createdBy: ctx.userId ?? null,
			clientId: ctx.clientId ?? null,
		});
	}

	const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

	// Post-commit: any blocked (human-owned or policy-gated) fields become a
	// single durable approval card. updateEntity packaged them as a deferred
	// mutation; queue() runs AFTER the entity tx + change event so the approval
	// (run + event + notification) is never rolled back with the edit — same
	// rule as complete_window's deferred creates.
	const blockedPaths = Object.keys(updatedEntity.fieldMerge?.blocked ?? {});
	const deferred = updatedEntity.deferred;
	let approvalQueued = false;
	let approvalUrl: string | undefined;
	let approvalRunId: number | undefined;
	let approvalFields: Record<string, unknown> | undefined;
	let approvalCurrent: Record<string, unknown> | undefined;
	if (deferred) {
		const res = await deferred.queue(ctx, env);
		approvalQueued = true;
		approvalUrl = res.approvalUrl;
		approvalRunId = res.runId;
		approvalFields = deferred.display.fields;
		approvalCurrent = deferred.display.current;
	}

	return {
		action: "update",
		entity: {
			id: entityDetails.id,
			entity_type: entityDetails.entity_type,
			name: entityDetails.name,
			slug: entityDetails.slug,
			parent_id: entityDetails.parent_id,
			parent_name: entityDetails.parent_name,
			parent_slug: entityDetails.parent_slug ?? null,
			metadata: entityDetails.metadata ?? {},
			enabled_classifiers: entityDetails.enabled_classifiers,
			view_url: viewUrl,
		},
		applied_fields: updatedEntity.fieldMerge?.applied,
		blocked_fields: blockedPaths.length > 0 ? blockedPaths : undefined,
		approval_queued: approvalQueued || undefined,
		approval_url: approvalUrl,
		approval_run_id: approvalRunId,
		approval_fields: approvalFields,
		approval_current: approvalCurrent,
		approval_attribution: deferred ? deferred.display.attribution : undefined,
	};
}

// Access policy for the built-in $member entity type:
//  - Anyone who isn't a member of the org cannot see the member list at all.
//  - Members who aren't admin/owner see names + non-PII metadata, but not the
//    email address.
//  - Only admin/owner see the email field.
function canSeeMemberList(ctx: ToolContext): boolean {
  return !!ctx.memberRole;
}

function canSeeMemberEmail(ctx: ToolContext): boolean {
  return isAdminOrOwnerRole(ctx.memberRole);
}

function redactMemberEmail(
	metadata: Record<string, unknown>,
	schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { emailField } = resolveMemberSchemaFieldsFromSchema(schema);
  if (!(emailField in metadata)) return metadata;
  const { [emailField]: _removed, ...rest } = metadata;
  return rest;
}

/**
 * Fold a duplicate entity (`entity_id`, the loser) into the one it really is
 * (`winner_entity_id`). Admin/owner only — a merge is destructive and hard to
 * spot after the fact. The heavy lifting (move identities/aliases/edges,
 * tombstone + forward the loser, flatten chains) is in `applyMerge`; this
 * handler is the org-scoped gate + validation.
 */
async function handleMerge(
	args: ManageEntityArgs,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!isAdminOrOwnerRole(ctx.memberRole)) {
		throw new ToolUserError("Only an admin or owner may merge entities", 403);
	}
	const loserId = args.entity_id;
	const winnerId = args.winner_entity_id;
	if (!loserId)
		throw new ToolUserError(
			"entity_id (the duplicate to fold in) is required for merge",
			400,
		);
	if (!winnerId)
		throw new ToolUserError(
			"winner_entity_id (the survivor) is required for merge",
			400,
		);
	if (loserId === winnerId)
		throw new ToolUserError("entity_id and winner_entity_id must differ", 400);

	const sql = getDb();
	// Both entities must be live and in the caller's org — never merge across a
	// tenant boundary or into a deleted/foreign entity.
	const rows = (await sql`
    SELECT id FROM entities
    WHERE organization_id = ${ctx.organizationId}
      AND id IN (${loserId}, ${winnerId})
      AND deleted_at IS NULL
  `) as Array<{ id: number }>;
	const found = new Set(rows.map((r) => Number(r.id)));
	if (!found.has(loserId))
		throw new ToolUserError(
			`Entity ${loserId} not found in this workspace`,
			404,
		);
	if (!found.has(winnerId))
		throw new ToolUserError(
			`Entity ${winnerId} not found in this workspace`,
			404,
		);

	let result: Awaited<ReturnType<typeof applyMerge>>;
	try {
		result = await applyMerge({
			orgId: ctx.organizationId,
			loserId,
			winnerId,
			mergedBy: ctx.agentId ?? ctx.userId ?? "system",
		});
	} catch (err) {
		throw new ToolUserError(
			`Merge failed: ${err instanceof Error ? err.message : String(err)}`,
			409,
		);
	}

	return {
		action: "merge",
		success: true,
		message: `Merged entity ${loserId} into ${winnerId} (${result.movedIdentities} identities moved, ${result.repointedEdges} edges re-pointed).`,
		winner_entity_id: winnerId,
		loser_entity_id: loserId,
		moved_identities: result.movedIdentities,
		repointed_edges: result.repointedEdges,
	};
}

/**
 * Reverse a merge: split a tombstoned loser (`entity_id`) back out of the winner
 * it was folded into. The winner is recovered from the loser's own `merged_into`
 * pointer (not passed in). Admin/owner only, org-fenced. The reconstruction from
 * the `merged_from_entity_id` markers + the one-hop chain guard live in
 * `applyUnmerge`; this handler is the gate + validation.
 */
async function handleUnmerge(
	args: ManageEntityArgs,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!isAdminOrOwnerRole(ctx.memberRole)) {
		throw new ToolUserError(
			"Only an admin or owner may un-merge entities",
			403,
		);
	}
	const loserId = args.entity_id;
	if (!loserId)
		throw new ToolUserError(
			"entity_id (the merged loser to split out) is required for unmerge",
			400,
		);

	const sql = getDb();
	// The loser is a TOMBSTONE (deleted_at set by the merge), so we validate org
	// membership without the live filter the merge handler uses. It must exist and
	// currently be forwarded (merged_into set) — otherwise there's nothing to undo.
	const [row] = (await sql`
    SELECT id, merged_into FROM entities
    WHERE organization_id = ${ctx.organizationId} AND id = ${loserId}
  `) as Array<{ id: number; merged_into: number | null }>;
	if (!row)
		throw new ToolUserError(
			`Entity ${loserId} not found in this workspace`,
			404,
		);
	if (row.merged_into === null) {
		throw new ToolUserError(
			`Entity ${loserId} is not merged into anything — nothing to un-merge`,
			409,
		);
	}

	let result: Awaited<ReturnType<typeof applyUnmerge>>;
	try {
		result = await applyUnmerge({
			orgId: ctx.organizationId,
			loserId,
			unmergedBy: ctx.agentId ?? ctx.userId ?? "system",
		});
	} catch (err) {
		throw new ToolUserError(
			`Un-merge failed: ${err instanceof Error ? err.message : String(err)}`,
			409,
		);
	}

	return {
		action: "unmerge",
		success: true,
		message: `Un-merged entity ${loserId} out of ${result.winnerId} (${result.restoredIdentities} identities restored).`,
		winner_entity_id: result.winnerId,
		loser_entity_id: loserId,
		restored_identities: result.restoredIdentities,
	};
}

async function handleList(
	args: ManageEntityArgs,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (args.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(ctx)) {
		throw new Error(
			"The member list is only visible to members of this workspace. Join the workspace to see members.",
		);
	}

	const sql = getDb();

	// Run list query and entity type schema fetch in parallel
	const [listResult, entityTypeRow] = await Promise.all([
		listEntities(
			{
				entity_type: args.entity_type,
				parent_id: args.parent_id,
				search: args.search,
				category: args.category,
				main_market: args.main_market,
				market: args.market,
				limit: args.limit,
				offset: args.offset,
				sort_by: args.sort_by,
				sort_order: args.sort_order,
			},
			env,
			ctx,
		),
		args.entity_type
			? sql`SELECT metadata_schema FROM entity_types WHERE slug = ${args.entity_type} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`.then(
					(r) => r[0] ?? null,
				)
			: Promise.resolve(null),
	]);

	const { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder } =
		listResult;

	// Batch-load relationships if schema declares x-table-relationships
	const schema = entityTypeRow?.metadata_schema as Record<
		string,
		unknown
	> | null;
	const relSpecs = (schema?.["x-table-relationships"] ??
		[]) as RelationshipColumnSpec[];
	const entityIds = entities.map((e) => e.id);

	// Batch-load relationships and linked-column lookups in parallel.
	const [relMap, linkedEntities] = await Promise.all([
		relSpecs.length > 0 && entityIds.length > 0
			? batchLoadRelationships(entityIds, relSpecs, ctx.organizationId)
			: Promise.resolve(new Map()),
		resolveLinkedColumns(entities, schema, ctx.organizationId),
	]);

	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	const hideMemberEmail = !canSeeMemberEmail(ctx);

	return {
		action: "list",
		entities: entities.map((e) => {
			const entityInfo = ownerSlug ? toEntityInfo(ownerSlug, e) : null;
			const rawMetadata = e.metadata ?? {};
			const metadata =
				hideMemberEmail && e.entity_type === MEMBER_ENTITY_TYPE_SLUG
					? redactMemberEmail(rawMetadata, schema)
					: rawMetadata;
			return {
				id: e.id,
				entity_type: e.entity_type,
				name: e.name,
				slug: e.slug,
				parent_id: e.parent_id,
				parent_name: e.parent_name,
				parent_slug: e.parent_slug,
				parent_entity_type: e.parent_entity_type,
				metadata,
				enabled_classifiers: e.enabled_classifiers,
				// Row `created_at` is a Date; the schema (and wire shape) is an ISO
				// string, so convert at the source rather than leaning on the emission
				// layer's coercion.
				created_at: toIsoStringOrNow(e.created_at),
				total_content: e.total_content,
				active_connections: e.active_connections,
				watchers_count: e.watchers_count,
				children_count: e.children_count,
				view_url: entityInfo ? buildEntityUrl(entityInfo, baseUrl) : undefined,
				...(relMap.size > 0 && relMap.has(e.id)
					? { relationships: relMap.get(e.id) }
					: {}),
			};
		}),
		...(Object.keys(linkedEntities).length > 0
			? { linked_entities: linkedEntities }
			: {}),
		metadata: {
			page_size: entities.length,
			has_more: hasMore,
			total_count: totalCount,
			limit,
			offset,
			sort_by: sortBy,
			sort_order: sortOrder,
			filtered_by_type: args.entity_type,
		},
	};
}

/**
 * Resolve every `x-link-entity-type` column on the schema to `{slug, name}`
 * pairs in one batch per (entityType, lookupField). Replaces the previous
 * FE pattern of `useQueries` fanning out one full-table fetch per linked
 * column. Returns a map keyed `${entityType}:${lookupField}` → lookup-value
 * → ref. Empty object if the schema declares no linked columns or none of
 * the visible rows reference linked values.
 */
async function resolveLinkedColumns(
	entities: Array<{ metadata?: Record<string, any> | null }>,
	schema: Record<string, unknown> | null,
	organizationId: string,
): Promise<
	Record<
		string,
		Record<string, { slug: string; entity_type: string; name: string }>
	>
> {
	if (!schema || entities.length === 0) return {};
	const properties = (schema as { properties?: Record<string, any> })
		.properties;
	if (!properties) return {};

	// Collect (linkedType, lookupField) → set of referenced values from the rows.
	const buckets = new Map<
		string,
		{ entityType: string; lookupField: string; values: Set<string> }
	>();
	for (const [columnKey, prop] of Object.entries(properties)) {
		const linkedType = (prop as { "x-link-entity-type"?: unknown })[
			"x-link-entity-type"
		];
		if (typeof linkedType !== "string" || linkedType === "") continue;
		const lookupFieldRaw = (prop as { "x-link-lookup-field"?: unknown })[
			"x-link-lookup-field"
		];
		const lookupField =
			typeof lookupFieldRaw === "string" && lookupFieldRaw
				? lookupFieldRaw
				: "slug";
		const bucketKey = `${linkedType}:${lookupField}`;
		let bucket = buckets.get(bucketKey);
		if (!bucket) {
			bucket = { entityType: linkedType, lookupField, values: new Set() };
			buckets.set(bucketKey, bucket);
		}
		for (const e of entities) {
			const raw = e.metadata?.[columnKey];
			const list = Array.isArray(raw) ? raw : [raw];
			for (const v of list) {
				if (v == null) continue;
				const s = String(v).trim();
				if (s !== "") bucket.values.add(s);
			}
		}
	}
	if (buckets.size === 0) return {};

	const sql = getDb();
	const out: Record<
		string,
		Record<string, { slug: string; entity_type: string; name: string }>
	> = {};

	await Promise.all(
		[...buckets.entries()].map(
			async ([bucketKey, { entityType, lookupField, values }]) => {
				if (values.size === 0) return;
				const valuesArr = [...values];
				const valuesLiteral = pgTextArray(valuesArr);
				const rows =
					lookupField === "slug"
						? await sql<{
								slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.slug, et.slug AS entity_type, e.name, e.slug AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND e.slug = ANY(${valuesLiteral}::text[])
            `
						: await sql<{
								slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.slug, et.slug AS entity_type, e.name, (e.metadata->>${lookupField}) AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND (e.metadata->>${lookupField}) = ANY(${valuesLiteral}::text[])
            `;
      if (rows.length === 0) return;
      const bucketMap: Record<string, { slug: string; entity_type: string; name: string }> = {};
      for (const r of rows) {
        if (r.lookup_value == null) continue;
        bucketMap[r.lookup_value] = { slug: r.slug, entity_type: r.entity_type, name: r.name };
      }
      out[bucketKey] = bucketMap;
    })
  );

  return out;
}

async function handleGet(
	entityId: number,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const entity = await getEntity(entityId, env, ctx);

	if (!entity) {
		throw new Error(`Entity with ID ${entityId} not found`);
	}

	if (
		entity.entity_type === MEMBER_ENTITY_TYPE_SLUG &&
		!canSeeMemberList(ctx)
	) {
		throw new Error(
			"Member details are only visible to members of this workspace. Join the workspace to see members.",
		);
	}

	const viewUrl = await buildEntityViewUrl(ctx, entity);

	let metadata = entity.metadata ?? {};
	if (
		entity.entity_type === MEMBER_ENTITY_TYPE_SLUG &&
		!canSeeMemberEmail(ctx)
	) {
		const sql = getDb();
		const rows = await sql`
      SELECT metadata_schema FROM entity_types
      WHERE slug = ${MEMBER_ENTITY_TYPE_SLUG} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      LIMIT 1
    `;
    const memberSchema = (rows[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
    metadata = redactMemberEmail(metadata, memberSchema);
  }

  return {
    action: 'get',
    entity: {
      id: entity.id,
      entity_type: entity.entity_type,
      name: entity.name,
      slug: entity.slug,
      parent_id: entity.parent_id,
      parent_name: entity.parent_name,
      parent_slug: entity.parent_slug ?? null,
      metadata,
      enabled_classifiers: entity.enabled_classifiers,
      created_at: toIsoStringOrNow(entity.created_at),
      view_url: viewUrl,
    },
  };
}

async function handleDelete(
	entityId: number,
	force: boolean,
	env: Env,
	ctx: ToolContext,
	args?: ManageEntityArgs,
): Promise<ManageEntityResult> {
	// Get entity info before deletion
	const entity = await getEntity(entityId, env, ctx);
	if (!entity) {
		throw new Error(`Entity with ID ${entityId} not found`);
	}

	const policyArgs = args ?? { action: "delete", entity_id: entityId };
	const attribution: "agent" | "watcher" = args?.watcher_source
		? "watcher"
		: "agent";
	const current = {
		id: entity.id,
		entity_type: entity.entity_type,
		name: entity.name,
		slug: entity.slug,
		parent_id: entity.parent_id,
		metadata: entity.metadata ?? {},
	};
	const deleteDecision = await runMutationGate({
		action: "delete",
		organizationId: ctx.organizationId,
		principalKind: principalKindForMutation(policyArgs as ManageEntityArgs, ctx),
		sql: getDb(),
		attribution,
		watcherId: args?.watcher_source?.watcher_id ?? null,
		windowId: args?.watcher_source?.window_id ?? null,
		principalId: mutationPrincipalId({
			agentId: ctx.agentId,
			watcherId: args?.watcher_source?.watcher_id ?? null,
		}),
		entityTypeSlug: entity.entity_type,
		entityId,
		entityOrgId: null,
		forceDeleteTree: force,
		current,
	});
	if (deleteDecision.outcome === "deny") {
		throw new ToolUserError(deleteDecision.reason, 403);
	}
	if (deleteDecision.outcome === "defer") {
		const res = await deleteDecision.deferred.queue(ctx, env);
		return {
			action: "delete",
			success: false,
			message: `Delete queued for approval: ${entity.name}`,
			deleted_count: 0,
			approval_queued: true,
			approval_url: res.approvalUrl,
			approval_run_id: res.runId,
			approval_action: "delete",
			approval_proposal: {
				entity_id: entity.id,
				entity_type: entity.entity_type,
				name: entity.name,
				force_delete_tree: force,
			},
			approval_current: current,
			approval_attribution: attribution,
		} as ManageEntityResult;
	}

	const result = await deleteEntity(entityId, force, env, ctx);

	return {
		action: "delete",
		success: true,
		message: result.message,
		deleted_count: result.deleted,
	};
}

// ============================================
// Relationship (Link) Helpers
// ============================================

const RELATIONSHIP_SELECT = `
  r.id,
  r.organization_id,
  r.from_entity_id,
  r.to_entity_id,
  r.relationship_type_id,
  rt.slug as relationship_type_slug,
  rt.name as relationship_type_name,
  rt.is_symmetric,
  fe.name as from_entity_name,
  fet.slug as from_entity_type,
  te.name as to_entity_name,
  tet.slug as to_entity_type,
  r.metadata,
  r.confidence,
  r.source,
  r.created_by,
  r.updated_by,
  r.created_at,
  r.updated_at,
  r.deleted_at
`;

const RELATIONSHIP_JOINS = `
  FROM entity_relationships r
  JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
  LEFT JOIN entities fe ON r.from_entity_id = fe.id
  LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
  LEFT JOIN entities te ON r.to_entity_id = te.id
  LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
`;

// ============================================
// Relationship (Link) Action Handlers
// ============================================

async function handleLink(
	args: ManageEntityArgs,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!args.from_entity_id)
		throw new ToolUserError("from_entity_id is required for link", 400);
	if (!args.to_entity_id)
		throw new ToolUserError("to_entity_id is required for link", 400);
	if (!args.relationship_type_slug)
		throw new ToolUserError("relationship_type_slug is required for link", 400);

	const sql = getDb();

	validateNoSelfReference(args.from_entity_id, args.to_entity_id);
	await validateScopeRule(args.from_entity_id, args.to_entity_id, env, ctx);

	// Schema search path for relationship types: tenant first, then any
	// visibility='public' catalog. Mirrors createEntity's resolver so a tenant
	// can use a canonical relationship type like `works_at` defined in
	// public-uk-finance without registering a local copy. Tenant-local types
	// win when both exist.
	const typeRows = await sql`
    SELECT rt.id, rt.is_symmetric
    FROM entity_relationship_types rt
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${args.relationship_type_slug}
      AND rt.deleted_at IS NULL
      AND (
        rt.organization_id = ${ctx.organizationId}
        OR o.visibility = 'public'
      )
    ORDER BY (rt.organization_id = ${ctx.organizationId}) DESC, rt.id ASC
    LIMIT 1
  `;
  if (typeRows.length === 0) {
    throw new Error(`Relationship type "${args.relationship_type_slug}" not found`);
  }
  const typeId = Number(typeRows[0].id);
  const isSymmetric = Boolean(typeRows[0].is_symmetric);

  await validateTypeRule(typeId, args.from_entity_id, args.to_entity_id, sql);

  let fromId = args.from_entity_id;
  let toId = args.to_entity_id;
  if (isSymmetric) {
    // For symmetric same-org pairs we canonicalize by id so dedup catches
    // a → b and b → a as the same edge. For cross-org pairs (target in a
    // public catalog), keep the caller's-org entity as `from` even if its
    // id is higher, so the stored source matches the semantic source. The
    // canonical form would otherwise leave rows where `from_entity_id`
    // points at a public catalog row under a tenant `organization_id` —
    // tenant-owned but cosmetically inverted.
    const orgRows = await sql<{ id: number; organization_id: string }>`
      SELECT id, organization_id FROM entities WHERE id IN (${fromId}, ${toId})
    `;
		const orgOf = (id: number) =>
			String(orgRows.find((r) => Number(r.id) === id)?.organization_id);
		const sameOrg =
			orgOf(fromId) === ctx.organizationId &&
			orgOf(toId) === ctx.organizationId;
		if (sameOrg) {
			const canonical = canonicalizeSymmetricEdge(fromId, toId);
			fromId = canonical.from;
			toId = canonical.to;
		}
		// else: cross-org symmetric — preserve caller-from / public-to.
		// validateScopeRule already required `from` to be in caller's org.
	}

	await checkDuplicateEdge(fromId, toId, typeId, sql);

	validateConfidence(args.confidence);
	validateSource(args.source);
	const source = args.source ?? "api";
	const confidence =
		args.confidence ?? (source === "ui" || source === "api" ? 1.0 : null);

	const inserted = await sql`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by,
      created_at, updated_at
    ) VALUES (
      ${ctx.organizationId},
      ${fromId},
      ${toId},
      ${typeId},
      ${args.metadata ? sql.json(args.metadata) : null},
      ${confidence},
      ${source},
      ${ctx.userId},
      ${ctx.userId},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  const relationshipId = Number((inserted[0] as { id: unknown }).id);

  const created = await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
    [relationshipId]
  );

  return { action: 'link', relationship: created[0] };
}

async function handleUnlink(args: ManageEntityArgs, ctx: ToolContext): Promise<ManageEntityResult> {
  if (!args.relationship_id) throw new Error('relationship_id is required for unlink');

  const sql = getDb();

  const existing = await sql`
    SELECT id, organization_id FROM entity_relationships
    WHERE id = ${args.relationship_id} AND deleted_at IS NULL
    LIMIT 1
  `;
	if (existing.length === 0) {
		throw new Error(`Relationship ${args.relationship_id} not found`);
	}
	if (String(existing[0].organization_id) !== ctx.organizationId) {
		throw new Error(
			"Access denied: relationship belongs to another organization",
		);
	}

	await sql`
    UPDATE entity_relationships
    SET deleted_at = current_timestamp, updated_at = current_timestamp, updated_by = ${ctx.userId}
    WHERE id = ${args.relationship_id}
  `;

	return {
		action: "unlink",
		success: true,
		message: `Relationship ${args.relationship_id} deleted`,
	};
}

async function handleUpdateLink(
	args: ManageEntityArgs,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
  if (!args.relationship_id) throw new Error('relationship_id is required for update_link');

  const sql = getDb();

  const existing = await sql`
    SELECT id, organization_id FROM entity_relationships
    WHERE id = ${args.relationship_id} AND deleted_at IS NULL
    LIMIT 1
  `;
	if (existing.length === 0) {
		throw new Error(`Relationship ${args.relationship_id} not found`);
	}
	if (String(existing[0].organization_id) !== ctx.organizationId) {
		throw new Error(
			"Access denied: relationship belongs to another organization",
		);
	}

	validateConfidence(args.confidence);
	validateSource(args.source);

	const hasMetadata = args.metadata !== undefined;
	const metadataJson = hasMetadata ? sql.json(args.metadata) : null;

	await sql`
    UPDATE entity_relationships SET
      metadata = CASE
        WHEN ${hasMetadata} THEN ${metadataJson}
        ELSE metadata
      END,
      confidence = COALESCE(${args.confidence ?? null}, confidence),
      source = COALESCE(${args.source ?? null}, source),
      updated_by = ${ctx.userId},
      updated_at = current_timestamp
    WHERE id = ${args.relationship_id}
  `;

  const updated = await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
    [args.relationship_id]
  );

  return { action: 'update_link', relationship: updated[0] };
}

async function handleListLinks(
	args: ManageEntityArgs,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!args.entity_id)
		throw new ToolUserError("entity_id is required for list_links", 400);

	const sql = getDb();
	const direction = args.direction ?? "both";
	const includeDeleted = args.include_deleted ?? false;
	const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
	const offset = Math.max(args.offset ?? 0, 0);

	const conditions: string[] = ["r.organization_id = $1"];
	const params: unknown[] = [ctx.organizationId];
	let paramIdx = 2;

	if (!includeDeleted) {
		conditions.push("r.deleted_at IS NULL");
	}

	if (direction === "outbound") {
		conditions.push(`(r.from_entity_id = $${paramIdx})`);
		params.push(args.entity_id);
		paramIdx++;
	} else if (direction === "inbound") {
		conditions.push(`(r.to_entity_id = $${paramIdx})`);
		params.push(args.entity_id);
		paramIdx++;
	} else {
		conditions.push(
			`(r.from_entity_id = $${paramIdx} OR r.to_entity_id = $${paramIdx})`,
		);
		params.push(args.entity_id);
		paramIdx++;
	}

	if (args.relationship_type_slug) {
		conditions.push(`rt.slug = $${paramIdx}`);
		params.push(args.relationship_type_slug);
		paramIdx++;
	}

	if (args.source) {
		conditions.push(`r.source = $${paramIdx}`);
		params.push(args.source);
		paramIdx++;
	}

	if (args.confidence_min !== undefined) {
		conditions.push(`r.confidence >= $${paramIdx}`);
		params.push(args.confidence_min);
		paramIdx++;
	}

	const whereClause = conditions.join(" AND ");

	const countResult = await sql.unsafe<{ total: number }>(
		`SELECT COUNT(*)::int as total ${RELATIONSHIP_JOINS} WHERE ${whereClause}`,
		params,
	);
	const total = Number(countResult[0]?.total ?? 0);

	const rows = await sql.unsafe<RelationshipRow>(
		`SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS}
     WHERE ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT ${limit + 1}
     OFFSET ${offset}`,
    params
  );

  const hasMore = rows.length > limit;
  const relationships = hasMore ? rows.slice(0, limit) : rows;

  const countsResult = await sql.unsafe<RelationshipCountByType>(
    `SELECT
      rt.slug as relationship_type_slug,
      rt.name as relationship_type_name,
      COUNT(*)::int as count
    ${RELATIONSHIP_JOINS}
    WHERE ${whereClause}
    GROUP BY rt.slug, rt.name
    ORDER BY count DESC`,
    params
  );

  return {
    action: 'list_links',
    relationships,
    counts_by_type: countsResult,
    metadata: { total, limit, offset, has_more: hasMore },
  };
}
