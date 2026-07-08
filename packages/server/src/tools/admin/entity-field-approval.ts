/**
 * Durable approval gate for a watcher's proposed change to a HUMAN-OWNED entity
 * field. Mirrors the manage_agents builder gate: a watcher that wants to overwrite
 * a field a human owns does NOT write — it queues a pending `runs` row
 * (run_type='internal', action_key='entity_field_change') + an
 * `interaction_type='approval'` event, and notifies the org's humans (durable
 * notification, no SSE dependency — headless + multi-replica safe). On approve the
 * change is applied via `mergeEntityFields` (the field stays human-owned, now
 * carrying the approved value); on reject nothing changes.
 *
 * This leaf owns only the queue + apply (like manage_agents); the
 * claim/try-approve/try-reject orchestration lives in manage_operations next to
 * `supersedeActionEvent`.
 */

import { resolveEntityApprovalPolicy } from "../../authz/entity-approval-policy";
import { getDb } from "../../db/client";
import type { Env } from "../../index";
import { notifyActionApprovalNeeded } from "../../notifications/triggers";
import {
	type FieldMergeResult,
	mergeEntityFields,
} from "../../utils/entity-field-merge";
import {
	createEntity,
	deleteEntity,
	type EntityData,
} from "../../utils/entity-management";
import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import {
	buildEntityUrl,
	buildResourcePermalink,
} from "../../utils/url-builder";
import type { ToolContext } from "../registry";
import { getOrgUrlContext } from "../view-urls";

/** Synthetic runs.action_key tagging a watcher field-change held for approval. */
export const ENTITY_FIELD_CHANGE_ACTION_KEY = "entity_field_change";
export const ENTITY_CHANGE_ACTION_KEY = "entity_change";
export const ENTITY_CHANGE_ACTION_KEYS = [
	ENTITY_FIELD_CHANGE_ACTION_KEY,
	ENTITY_CHANGE_ACTION_KEY,
] as const;

/** Proposed field changes held in runs.action_input for a field-change gate run. */
export interface EntityFieldChangeProposal {
	operation?: "update";
	entity_id: number;
	/** field_path -> proposed value (what the watcher/agent wanted to write). */
	fields: Record<string, unknown>;
	/** field_path -> current human-owned value (for the diff card). */
	current?: Record<string, unknown>;
	watcher_id?: number | null;
	/** Who proposed the change — drives the card label/author. Defaults to 'watcher'. */
	attribution?: "watcher" | "agent";
	reason?: string | null;
}

export interface EntityDeleteProposal {
	operation: "delete";
	entity_id: number;
	force_delete_tree?: boolean;
	current: {
		id: number;
		entity_type: string;
		name: string;
		slug?: string | null;
		parent_id?: number | null;
		metadata?: Record<string, unknown> | null;
	};
	watcher_id?: number | null;
	attribution?: "watcher" | "agent";
	reason?: string | null;
}

export interface EntityCreateProposal {
	operation: "create";
	entity_data: EntityData;
	proposal: Record<string, unknown>;
	watcher_id?: number | null;
	attribution?: "watcher" | "agent";
	reason?: string | null;
}

export type EntityChangeProposal =
	| EntityFieldChangeProposal
	| EntityDeleteProposal
	| EntityCreateProposal;

function formatLabel(value: string): string {
	return value
		.replace(/^\$/, "")
		.replace(/[_-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (char) => char.toUpperCase());
}

function formatFieldChangeAction(
	entityType: string | null | undefined,
	fields: string[],
): string {
	const fieldList = fields.map(formatLabel).join(", ") || "field";
	const fieldNoun = fields.length === 1 ? "field" : "fields";
	const entityLabel = entityType
		? formatLabel(entityType).toLowerCase()
		: "entity";
	return `Update ${entityLabel} ${fieldNoun}: ${fieldList}`;
}

function operationOf(
	proposal: EntityChangeProposal,
): "create" | "update" | "delete" {
	return proposal.operation ?? "update";
}

function asUpdateProposal(
	proposal: EntityChangeProposal,
): EntityFieldChangeProposal {
	return proposal as EntityFieldChangeProposal;
}

function asDeleteProposal(
	proposal: EntityChangeProposal,
): EntityDeleteProposal {
	return proposal as EntityDeleteProposal;
}

function asCreateProposal(
	proposal: EntityChangeProposal,
): EntityCreateProposal {
	return proposal as EntityCreateProposal;
}

async function loadWatcherLabel(
	ctx: ToolContext,
	watcherId: number | null | undefined,
	attribution: "watcher" | "agent" | undefined,
): Promise<{
	actorLabel: string;
	watcherName: string | null;
	watcherAgentId: string | null;
}> {
	if (attribution !== "watcher") {
		return { actorLabel: "An agent", watcherName: null, watcherAgentId: null };
	}
	if (!watcherId) {
		return { actorLabel: "A watcher", watcherName: null, watcherAgentId: null };
	}
	const rows = await getDb()<{
		name: string | null;
		agent_id: string | null;
	}>`
    SELECT name, agent_id
    FROM watchers
    WHERE id = ${watcherId}
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
	return {
		actorLabel: rows[0]?.name ?? `Watcher ${watcherId}`,
		watcherName: rows[0]?.name ?? null,
		watcherAgentId: rows[0]?.agent_id ?? null,
	};
}

async function loadEntitySnapshot(
	ctx: ToolContext,
	entityId: number,
): Promise<{
	id: number;
	name: string | null;
	entity_type: string | null;
	slug: string | null;
	parent_id: number | null;
	parent_slug: string | null;
	parent_entity_type: string | null;
	metadata: Record<string, unknown> | null;
} | null> {
	const rows = await getDb()<{
		id: number;
		name: string | null;
		entity_type: string | null;
		slug: string | null;
		parent_id: number | null;
		parent_slug: string | null;
		parent_entity_type: string | null;
		metadata: Record<string, unknown> | null;
	}>`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug, e.parent_id, e.metadata,
           parent.slug AS parent_slug, pet.slug AS parent_entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    WHERE e.id = ${entityId}
      AND e.organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
	return rows[0] ?? null;
}

/**
 * Queue a watcher field-change for approval. Returns the pending run/event ids.
 * Called post-commit from the watcher promotion path.
 */
export async function proposeEntityFieldChange(
	ctx: ToolContext,
	proposal: EntityFieldChangeProposal,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	return proposeEntityChange(ctx, { ...proposal, operation: "update" });
}

export async function proposeEntityDelete(
	ctx: ToolContext,
	proposal: Omit<EntityDeleteProposal, "operation">,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	return proposeEntityChange(ctx, { ...proposal, operation: "delete" });
}

export async function proposeEntityCreate(
	ctx: ToolContext,
	proposal: Omit<EntityCreateProposal, "operation">,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	return proposeEntityChange(ctx, { ...proposal, operation: "create" });
}

export async function proposeEntityChange(
	ctx: ToolContext,
	proposal: EntityChangeProposal,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const sql = getDb();
	const operation = operationOf(proposal);
	const updateProposal =
		operation === "update" ? asUpdateProposal(proposal) : null;
	const deleteProposal =
		operation === "delete" ? asDeleteProposal(proposal) : null;
	const createProposal =
		operation === "create" ? asCreateProposal(proposal) : null;
	const actionKey =
		operation === "update"
			? ENTITY_FIELD_CHANGE_ACTION_KEY
			: ENTITY_CHANGE_ACTION_KEY;

	// Idempotency: complete_window is replay-safe (retries + concurrent replicas),
	// so the same blocked field-change can be proposed more than once. Collapse to a
	// single pending approval — if an identical pending run already exists for this
	// org+entity+proposed-fields, reuse it instead of stacking duplicate cards.
	const existing = await sql<{ id: number; event_id: number | null }>`
    SELECT r.id,
           (SELECT e.id FROM events e
              WHERE e.run_id = r.id
                AND e.interaction_status = 'pending'
              ORDER BY e.id DESC LIMIT 1) AS event_id
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'internal'
      AND r.action_key = ${actionKey}
      AND r.approval_status = 'pending'
      AND r.status = 'pending'
      AND COALESCE(r.action_input->>'operation', 'update') = ${operation}
      AND COALESCE(r.action_input->>'entity_id', '') = ${"entity_id" in proposal ? String(proposal.entity_id) : ""}
	      AND (
	        ${operation !== "update"}
	        OR r.action_input->'fields' = ${sql.json(updateProposal?.fields ?? {})}::jsonb
	      )
	      AND (
	        ${operation !== "create"}
	        OR r.action_input->'entity_data' = ${sql.json(createProposal?.entity_data ?? {})}::jsonb
	      )
	    ORDER BY r.id DESC
    LIMIT 1
  `;
	if (existing.length > 0) {
		const runId = Number(existing[0].id);
		const eventId =
			existing[0].event_id != null ? Number(existing[0].event_id) : 0;
		return { runId, eventId };
	}

	const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      created_by_user_id, approval_status, status, created_at
    ) VALUES (
      ${ctx.organizationId}, 'internal', ${actionKey},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      null, 'pending', 'pending', current_timestamp
    )
    RETURNING id
  `;
	const runId = Number((inserted[0] as { id: unknown }).id);

	const fieldKeys = updateProposal ? Object.keys(updateProposal.fields) : [];
	const fieldList = fieldKeys.join(", ");
	const attribution = proposal.attribution ?? "watcher";
	const actorNoun = attribution === "agent" ? "An agent" : "A watcher";
	const [{ actorLabel, watcherName, watcherAgentId }, entity] =
		await Promise.all([
			loadWatcherLabel(ctx, proposal.watcher_id, attribution),
			operation === "create"
				? Promise.resolve(null)
				: loadEntitySnapshot(
						ctx,
						(proposal as EntityFieldChangeProposal | EntityDeleteProposal)
							.entity_id,
					),
		]);
	const entityType = createProposal
		? createProposal.entity_data.entity_type
		: entity?.entity_type;
	const entityName = createProposal
		? createProposal.entity_data.name
		: entity?.name;
	const actionLabel =
		operation === "update"
			? formatFieldChangeAction(entityType, fieldKeys)
			: operation === "delete"
				? `Delete ${entityType ? formatLabel(entityType).toLowerCase() : "entity"}`
				: `Create ${formatLabel(entityType ?? "entity").toLowerCase()}`;

	const event = await insertEvent({
		entityIds:
			operation === "create"
				? []
				: [
						(proposal as EntityFieldChangeProposal | EntityDeleteProposal)
							.entity_id,
					],
		organizationId: ctx.organizationId,
		originId: `run_${runId}_pending`,
		title: `${actionLabel} — pending approval`,
		content:
			proposal.reason ??
			(operation === "update"
				? `${actorNoun} proposed updating ${fieldList} on this entity.`
				: operation === "delete"
					? `${actorNoun} proposed deleting this entity.`
					: `${actorNoun} proposed creating this entity.`),
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInput: proposal as unknown as Record<string, unknown>,
		metadata: {
			tool: actionKey,
			action_key: actionKey,
			action: operation === "update" ? "change" : operation,
			entity_id: "entity_id" in proposal ? proposal.entity_id : null,
			fields: updateProposal ? updateProposal.fields : null,
			current: updateProposal
				? (updateProposal.current ?? null)
				: deleteProposal
					? deleteProposal.current
					: null,
			proposal: createProposal
				? createProposal.proposal
				: deleteProposal
					? {
							entity_id: deleteProposal.entity_id,
							entity_type:
								entity?.entity_type ?? deleteProposal.current.entity_type,
							name: entity?.name ?? deleteProposal.current.name,
							force_delete_tree: deleteProposal.force_delete_tree ?? false,
						}
					: null,
			watcher_id: proposal.watcher_id ?? null,
			watcher_name: watcherName,
			watcher_agent_id: watcherAgentId,
			entity_name: entityName ?? null,
			entity_type: entityType ?? null,
			entity_slug: createProposal ? null : (entity?.slug ?? null),
			parent_slug: createProposal ? null : (entity?.parent_slug ?? null),
			parent_entity_type: createProposal
				? null
				: (entity?.parent_entity_type ?? null),
			attribution,
			reason: proposal.reason ?? null,
			status: "pending_approval",
			run_id: runId,
		},
		authorName: attribution,
	});
	const eventId = Number(event.id);

	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	// Run-scoped: the pending event is superseded on approve→complete; a run link
	// stays valid across the chain. (Read-side content_ids resolution also covers
	// the event id below, carried for the notification's resourceId.)
	const approvalUrl = buildResourcePermalink(
		ownerSlug,
		{ kind: "run", runId },
		baseUrl,
	);
	const entityUrl =
		ownerSlug && entity?.entity_type && entity.slug
			? buildEntityUrl(
					{
						ownerSlug,
						entityType: entity.entity_type,
						slug: entity.slug,
						parentType: entity.parent_entity_type ?? null,
						parentSlug: entity.parent_slug ?? null,
					},
					baseUrl,
				)
			: undefined;
	const approvalPolicy = await resolveEntityApprovalPolicy({
		organizationId: ctx.organizationId,
		entityTypeSlug: entityType ?? null,
		fieldPath: updateProposal ? (fieldKeys[0] ?? null) : null,
	});
	const deliveryTarget = approvalPolicy.deliveryTarget;

	notifyActionApprovalNeeded({
		orgId: ctx.organizationId,
		runId,
		actionKey,
		connectionName: actionLabel,
		eventId,
		approvalUrl,
		connectionId: deliveryTarget.connectionId,
		channelId: deliveryTarget.channelId,
		teamId: deliveryTarget.teamId,
		details:
			operation === "update"
				? {
						kind: "entity_field_change",
						actorLabel,
						entityId: updateProposal?.entity_id ?? null,
						entityType: entity?.entity_type ?? null,
						entityName: entity?.name ?? null,
						entityUrl,
						fields: updateProposal?.fields ?? {},
						current: updateProposal?.current ?? null,
						reason: proposal.reason ?? null,
					}
				: {
						kind: "entity_change",
						operation,
						actorLabel,
						entityId: deleteProposal ? deleteProposal.entity_id : null,
						entityType: entityType ?? null,
						entityName: entityName ?? null,
						entityUrl,
						proposal: deleteProposal
							? {
									entity_id: deleteProposal.entity_id,
									entity_type:
										entity?.entity_type ?? deleteProposal.current.entity_type,
									name: entity?.name ?? deleteProposal.current.name,
									force_delete_tree: deleteProposal.force_delete_tree ?? false,
								}
							: (createProposal?.proposal ?? null),
						current: deleteProposal ? deleteProposal.current : null,
						reason: proposal.reason ?? null,
					},
	}).catch((error) =>
		logger.error(error, "Failed to send entity change approval notification"),
	);

	return { runId, eventId, approvalUrl };
}

/**
 * Apply an approved field-change proposal. The approver endorsed the value, so it
 * is written AND marked human-owned (now carrying the approved value) via
 * mergeEntityFields(source='human').
 */
export async function applyEntityFieldChangeProposal(
	proposal: EntityFieldChangeProposal,
	approverUserId: string | null,
): Promise<FieldMergeResult> {
	const sql = getDb();
	return await sql.begin(async (tx) =>
		mergeEntityFields({
			tx,
			entityId: proposal.entity_id,
			fields: proposal.fields,
			source: "human",
			actorId: approverUserId,
			note: proposal.reason ?? null,
			// Don't overwrite a field the human re-edited after this proposal was queued.
			expectedCurrent: proposal.current ?? null,
		}),
	);
}

export async function applyEntityChangeProposal(
	proposal: EntityChangeProposal,
	ctx: ToolContext,
	env: Env,
): Promise<unknown> {
	const operation = operationOf(proposal);
	if (operation === "update") {
		return applyEntityFieldChangeProposal(
			asUpdateProposal(proposal),
			ctx.userId ?? null,
		);
	}
	if (operation === "create") {
		const createProposal = asCreateProposal(proposal);
		return createEntity(
			{ ...createProposal.entity_data, organization_id: ctx.organizationId },
			{
				hookContext: {
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					env,
				},
			},
		);
	}
	const deleteProposal = asDeleteProposal(proposal);
	return deleteEntity(
		deleteProposal.entity_id,
		deleteProposal.force_delete_tree ?? false,
		env,
		ctx,
	);
}
