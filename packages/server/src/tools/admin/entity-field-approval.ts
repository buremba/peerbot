/**
 * Durable approval gate for entity mutations that need human review. Field
 * updates preserve human ownership through `mergeEntityFields`; held creates,
 * deletes, and merges use their normal mutation paths after approval. Every
 * proposal is a pending internal run plus an approval event, so delivery and
 * decisions remain durable across replicas. Claim/approve/reject orchestration
 * lives in manage_operations next to `supersedeActionEvent`.
 */

import { createHash } from "node:crypto";
import {
	ApprovalAttribution,
	type ApprovalAttribution as ApprovalAttributionType,
} from "@lobu/core/contracts/interaction-envelope";
import { resolveEntityApprovalPolicy } from "../../authz/entity-policy";
import { type DbClient, getDb, pgBigintArray } from "../../db/client";
import { assertResolutionFingerprintCurrent } from "../../entity-resolution/staleness";
import type { Env } from "../../index";
import {
	formatFieldChangeAction,
	formatLabel,
	notifyActionApprovalNeeded,
} from "../../notifications/triggers";
import {
	type FieldMergeResult,
	mergeEntityFields,
} from "../../utils/entity-field-merge";
import {
	createEntity,
	deleteEntity,
	type EntityData,
} from "../../utils/entity-management";
import { applyMergeGroupInTransaction } from "../../utils/entity-merge";
import { insertEvent, stableJson } from "../../utils/insert-event";
import logger from "../../utils/logger";
import {
	buildConnectionUrl,
	buildEntityUrl,
	buildResourcePermalink,
} from "../../utils/url-builder";
import { resolveRunInitiator, runPermalinkResource } from "../initiator";
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
	/**
	 * The watcher-run window that produced this proposal, if any. Stamped onto the
	 * `runs.window_id` COLUMN so a run that produced N proposals groups them
	 * into ONE batch approval card. Stripped from action_input before the insert.
	 */
	window_id?: number | null;
	/** Who proposed the change — drives the card label/author. Defaults to 'behavior'. */
	attribution?: ApprovalAttributionType;
	reason?: string | null;
	/**
	 * The ONE human who owns every gated field (distinct
	 * `field_controls[field].set_by`), resolved at propose time. Drives
	 * owner-routed delivery (Slack DM tier) and lets that owner approve the run
	 * without an admin role. Absent for mixed/no owners — admin-only behavior.
	 * Lives in action_input (not run_metadata) because the approve path and the
	 * Slack bridge already load action_input for the proposal; the dedupe SELECT
	 * compares the canonical change identity, so replays still collapse.
	 */
	owner_user_id?: string | null;
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
	/** See EntityFieldChangeProposal.window_id — batches proposals by run window. */
	window_id?: number | null;
	attribution?: ApprovalAttributionType;
	reason?: string | null;
}

export interface EntityCreateProposal {
	operation: "create";
	entity_data: EntityData;
	proposal: Record<string, unknown>;
	watcher_id?: number | null;
	/** See EntityFieldChangeProposal.window_id — batches proposals by run window. */
	window_id?: number | null;
	attribution?: ApprovalAttributionType;
	reason?: string | null;
}

export interface EntityMergeProposal {
	operation: "merge";
	entity_id: number;
	entity_ids?: number[];
	winner_entity_id: number;
	current: {
		loser: Record<string, unknown>;
		duplicates?: Record<string, unknown>[];
		winner: Record<string, unknown>;
	};
	evidence?: Array<{
		kind: string;
		identifier: string;
		identity_ids?: number[];
	}>;
	watcher_id?: number | null;
	window_id?: number | null;
	/** Window copied into action_input because runs.window_id is transport grouping. */
	source_window_id?: number | null;
	/** Watcher run that discovered this candidate (the approval run is separate). */
	source_run_id?: number | null;
	policy_hash?: string | null;
	resolution_fingerprint?: string | null;
	attribution?: ApprovalAttributionType;
	reason?: string | null;
	/**
	 * The proposer's own justification, in their words. Deliberately separate
	 * from `reason` (the server-recomputed policy verdict): an agent can claim
	 * anything here, so it is rendered as an attributed claim and never treated
	 * as evidence or allowed to influence the auto-merge decision.
	 */
	proposer_rationale?: string | null;
}

export type EntityChangeProposal =
	| EntityFieldChangeProposal
	| EntityDeleteProposal
	| EntityCreateProposal
	| EntityMergeProposal;

function operationOf(
	proposal: EntityChangeProposal,
): "create" | "update" | "delete" | "merge" {
	return proposal.operation ?? "update";
}

function asUpdateProposal(
	proposal: EntityChangeProposal,
): EntityFieldChangeProposal {
	if (proposal.operation === undefined || proposal.operation === "update") {
		return proposal;
	}
	throw new Error(`Expected update proposal, got ${proposal.operation}`);
}

function asDeleteProposal(
	proposal: EntityChangeProposal,
): EntityDeleteProposal {
	if (proposal.operation === "delete") return proposal;
	throw new Error(
		`Expected delete proposal, got ${proposal.operation ?? "update"}`,
	);
}

function asCreateProposal(
	proposal: EntityChangeProposal,
): EntityCreateProposal {
	if (proposal.operation === "create") return proposal;
	throw new Error(
		`Expected create proposal, got ${proposal.operation ?? "update"}`,
	);
}

function asMergeProposal(proposal: EntityChangeProposal): EntityMergeProposal {
	if (proposal.operation === "merge") return proposal;
	throw new Error(
		`Expected merge proposal, got ${proposal.operation ?? "update"}`,
	);
}

function changedEntityId(proposal: EntityChangeProposal): number {
	if (proposal.operation === "create") {
		throw new Error("Create proposals do not have an existing entity id");
	}
	return proposal.entity_id;
}

function mergeEntityIds(proposal: EntityMergeProposal): number[] {
	return proposal.entity_ids ?? [proposal.entity_id];
}

function entityChangeIdempotencyKey(
	organizationId: string,
	windowId: number | null,
	proposal: EntityChangeProposal,
): string {
	const operation = operationOf(proposal);
	let change: Record<string, unknown>;
	switch (operation) {
		case "update":
			change = {
				entityId: asUpdateProposal(proposal).entity_id,
				fields: asUpdateProposal(proposal).fields,
			};
			break;
		case "delete":
			change = {
				entityId: asDeleteProposal(proposal).entity_id,
				force: asDeleteProposal(proposal).force_delete_tree ?? false,
			};
			break;
		case "create":
			change = { entityData: asCreateProposal(proposal).entity_data };
			break;
		case "merge": {
			const merge = asMergeProposal(proposal);
			change = {
				winnerId: merge.winner_entity_id,
				loserIds: [...new Set(mergeEntityIds(merge))].sort((a, b) => a - b),
			};
			break;
		}
	}
	const digest = createHash("sha256")
		.update(stableJson({ organizationId, windowId, operation, change }))
		.digest("hex");
	return `entity-change:${digest}`;
}
async function loadWatcherLabel(
	ctx: ToolContext,
	watcherId: number | null | undefined,
	attribution: ApprovalAttributionType | undefined,
): Promise<{
	actorLabel: string;
	watcherName: string | null;
	watcherAgentId: string | null;
}> {
	if (attribution !== ApprovalAttribution.Behavior) {
		return { actorLabel: "An agent", watcherName: null, watcherAgentId: null };
	}
	if (!watcherId) {
		return { actorLabel: "A Behavior", watcherName: null, watcherAgentId: null };
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
		actorLabel: rows[0]?.name ?? `Behavior ${watcherId}`,
		watcherName: rows[0]?.name ?? null,
		watcherAgentId: rows[0]?.agent_id ?? null,
	};
}

interface EntitySnapshot {
	id: number;
	name: string | null;
	entity_type: string | null;
	slug: string | null;
	parent_id: number | null;
	parent_slug: string | null;
	parent_entity_type: string | null;
	identities: Array<{
		id: number;
		namespace: string;
		identifier: string;
		source_connector: string | null;
		connection_id: number | null;
		connection_name: string | null;
		connector_key: string | null;
	}>;
}

async function loadEntitySnapshots(
	ctx: ToolContext,
	entityIds: number[],
): Promise<EntitySnapshot[]> {
	if (entityIds.length === 0) return [];
	return getDb()<EntitySnapshot>`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug, e.parent_id,
           parent.slug AS parent_slug, pet.slug AS parent_entity_type,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', ei.id, 'namespace', ei.namespace, 'identifier', ei.identifier,
               'source_connector', ei.source_connector, 'connection_id', ei.connection_id,
               'connection_name', c.display_name, 'connector_key', c.connector_key
             ) ORDER BY ei.id)
             FROM entity_identities ei
             LEFT JOIN connections c ON c.id = ei.connection_id
             WHERE ei.entity_id = e.id AND ei.organization_id = e.organization_id
               AND ei.deleted_at IS NULL
           ), '[]'::jsonb) AS identities
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
      AND e.organization_id = ${ctx.organizationId}
  `;
}

async function loadEntitySnapshot(
	ctx: ToolContext,
	entityId: number,
): Promise<EntitySnapshot | null> {
	const rows = await loadEntitySnapshots(ctx, [entityId]);
	return rows[0] ?? null;
}

function toEntityReviewSnapshot(
	urlContext: Awaited<ReturnType<typeof getOrgUrlContext>>,
	entity: EntitySnapshot,
) {
	const { ownerSlug, baseUrl } = urlContext;
	const href =
		ownerSlug && entity.entity_type && entity.slug
			? buildEntityUrl(
					{
						ownerSlug,
						entityType: entity.entity_type,
						slug: entity.slug,
						parentType: entity.parent_entity_type,
						parentSlug: entity.parent_slug,
					},
					baseUrl,
				)
			: undefined;
	return {
		id: entity.id,
		name: entity.name,
		entity_type: entity.entity_type,
		slug: entity.slug,
		parent_id: entity.parent_id,
		parent_slug: entity.parent_slug,
		parent_entity_type: entity.parent_entity_type,
		...(href ? { href } : {}),
		identities: entity.identities.map((identity) => ({
			...identity,
			...(ownerSlug && identity.connection_id && identity.connector_key
				? {
						connection_href: buildConnectionUrl(
							ownerSlug,
							identity.connector_key,
							identity.connection_id,
							baseUrl,
						),
					}
				: {}),
		})),
	};
}

/**
 * The single human owner across a proposal's gated field paths, from
 * `entities.field_controls[field].set_by` (stamped on every human edit).
 * Exactly one distinct owner → that user; mixed owners or none → null
 * (admin-only routing/authority). Reserved $-attributes ($name/$parent_id/
 * $content) have no field_controls entry, so they contribute no owner.
 */
async function resolveProposalFieldOwner(
	organizationId: string,
	entityId: number,
	fieldPaths: string[],
): Promise<string | null> {
	const rows = await getDb()<{ field_controls: unknown }>`
    SELECT field_controls FROM entities
    WHERE id = ${entityId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	if (rows.length === 0) return null;
	const controls = (
		typeof rows[0].field_controls === "string"
			? JSON.parse(rows[0].field_controls)
			: (rows[0].field_controls ?? {})
	) as Record<string, { set_by?: string | null }>;
	const owners = new Set<string>();
	for (const path of fieldPaths) {
		const setBy = controls[path]?.set_by;
		if (setBy) owners.add(setBy);
	}
	return owners.size === 1 ? [...owners][0] : null;
}

/**
 * Queue a watcher field-change for approval. Returns the pending run/event ids.
 * Called post-commit from the watcher promotion path.
 */
export async function proposeEntityFieldChange(
	ctx: ToolContext,
	proposal: EntityFieldChangeProposal,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const ownerUserId = await resolveProposalFieldOwner(
		ctx.organizationId,
		proposal.entity_id,
		Object.keys(proposal.fields),
	);
	return proposeEntityChange(ctx, {
		...proposal,
		...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
		operation: "update",
	});
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

export async function proposeEntityMerge(
	ctx: ToolContext,
	proposal: Omit<EntityMergeProposal, "operation" | "current" | "entity_id"> & {
		entity_ids: number[];
	},
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const ids = [...new Set([...proposal.entity_ids, proposal.winner_entity_id])];
	const snapshots = await loadEntitySnapshots(ctx, ids);
	const byId = new Map(snapshots.map((entity) => [Number(entity.id), entity]));
	const requireSnapshot = (entityId: number) => {
		const snapshot = byId.get(entityId);
		if (!snapshot) throw new Error(`Entity ${entityId} not found`);
		return snapshot;
	};
	const urlContext = await getOrgUrlContext(ctx);
	const linkedDuplicates = proposal.entity_ids.map((entityId) =>
		toEntityReviewSnapshot(urlContext, requireSnapshot(entityId)),
	);
	const linkedWinner = toEntityReviewSnapshot(
		urlContext,
		requireSnapshot(proposal.winner_entity_id),
	);
	const [loser, ...rest] = linkedDuplicates;
	if (!loser) throw new Error("At least one duplicate entity is required");
	return proposeEntityChange(ctx, {
		...proposal,
		entity_id: loser.id,
		operation: "merge",
		current: { loser, duplicates: [loser, ...rest], winner: linkedWinner },
	});
}

export async function proposeEntityChange(
	ctx: ToolContext,
	proposal: EntityChangeProposal,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const sql = getDb();
	const operation = operationOf(proposal);
	// window_id groups a run's proposals into one batch card. It rides the column,
	// not action_input, and is part of the canonical idempotency key below.
	const { window_id: windowId, ...proposalWithoutWindow } = proposal;
	const actionInputProposal =
		operation === "merge"
			? { ...proposalWithoutWindow, source_window_id: windowId ?? null }
			: proposalWithoutWindow;
	const updateProposal =
		operation === "update" ? asUpdateProposal(proposal) : null;
	const deleteProposal =
		operation === "delete" ? asDeleteProposal(proposal) : null;
	const createProposal =
		operation === "create" ? asCreateProposal(proposal) : null;
	const mergeProposal =
		operation === "merge" ? asMergeProposal(proposal) : null;
	const actionKey =
		operation === "update"
			? ENTITY_FIELD_CHANGE_ACTION_KEY
			: ENTITY_CHANGE_ACTION_KEY;
	const idempotencyKey = entityChangeIdempotencyKey(
		ctx.organizationId,
		windowId ?? null,
		proposal,
	);
	const initiatorColumns = resolveRunInitiator(ctx);

	// Idempotency: complete_window is replay-safe (retries + concurrent replicas),
	// so the same blocked change can be proposed more than once. Collapse to one
	// active run — whether still pending or already applying — instead of stacking
	// duplicate cards or colliding with the global active-run idempotency index.
	// (Deletes match on force_delete_tree too: force and non-force are different
	// asks and must not affirm each other.)
	type ExistingChangeRun = {
		id: number;
		approval_status: string;
		status: string;
		pending_event_id: number | null;
		current_event_id: number | null;
	};
	const findExisting = (db: DbClient) => db<ExistingChangeRun>`
    SELECT r.id, r.approval_status, r.status,
           (SELECT e.id FROM current_event_records e
              WHERE e.run_id = r.id
                AND e.interaction_status = 'pending'
              ORDER BY e.id DESC LIMIT 1) AS pending_event_id,
           (SELECT e.id FROM current_event_records e
              WHERE e.run_id = r.id
                AND e.interaction_type = 'approval'
              ORDER BY e.id DESC LIMIT 1) AS current_event_id
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'internal'
      AND r.action_key = ${actionKey}
      AND (
        (
          r.idempotency_key = ${idempotencyKey}
          AND r.status IN ('pending', 'claimed', 'running')
        )
        OR (
          r.idempotency_key IS NULL
          AND r.approval_status = 'pending'
          AND r.status = 'pending'
          -- Same proposal from a different window is a distinct ask. This
          -- semantic fallback repairs pending rows created before canonical keys.
          AND r.window_id IS NOT DISTINCT FROM ${windowId ?? null}
          AND COALESCE(r.action_input->>'operation', 'update') = ${operation}
          AND COALESCE(r.action_input->>'entity_id', '') = ${"entity_id" in proposal ? String(proposal.entity_id) : ""}
          AND (
            ${operation !== "update"}
            OR r.action_input->'fields' = ${sql.json(updateProposal?.fields ?? {})}::jsonb
          )
          AND (
            ${operation !== "delete"}
            OR COALESCE((r.action_input->>'force_delete_tree')::boolean, false) = ${deleteProposal?.force_delete_tree ?? false}
          )
          AND (
            ${operation !== "create"}
            OR r.action_input->'entity_data' = ${sql.json(createProposal?.entity_data ?? {})}::jsonb
          )
          AND (
            ${operation !== "merge"}
            OR (
              COALESCE(r.action_input->>'winner_entity_id', '') = ${String(mergeProposal?.winner_entity_id ?? "")}
              AND COALESCE(r.action_input->'entity_ids', jsonb_build_array((r.action_input->>'entity_id')::bigint)) = ${sql.json(mergeProposal ? mergeEntityIds(mergeProposal) : [])}::jsonb
            )
          )
        )
      )
    ORDER BY (r.idempotency_key = ${idempotencyKey}) DESC, r.id DESC
    LIMIT 1
  `;

	const fieldKeys = updateProposal ? Object.keys(updateProposal.fields) : [];
	const fieldList = fieldKeys.join(", ");
	const attribution = proposal.attribution ?? ApprovalAttribution.Behavior;
	const actorNoun =
		attribution === ApprovalAttribution.Agent ? "An agent" : "A Behavior";
	const [{ actorLabel, watcherName, watcherAgentId }, entity] =
		await Promise.all([
			loadWatcherLabel(ctx, proposal.watcher_id, attribution),
			operation === "create"
				? Promise.resolve(null)
				: loadEntitySnapshot(ctx, changedEntityId(proposal)),
		]);
	const entityType = createProposal
		? createProposal.entity_data.entity_type
		: mergeProposal
			? String(mergeProposal.current.loser.entity_type ?? "entity")
			: entity?.entity_type;
	const entityName = createProposal
		? createProposal.entity_data.name
		: entity?.name;
	// Merge titles name both sides — this string is the event title that shows up
	// in timelines and notifications, where "Merge duplicate person" alone gives a
	// reviewer nothing to judge.
	const mergeLosers = mergeProposal
		? (mergeProposal.current.duplicates ?? [mergeProposal.current.loser])
				.map((duplicate) => duplicate.name)
				.filter(
					(name): name is string =>
						typeof name === "string" && name.trim().length > 0,
				)
		: [];
	const mergeWinnerName = mergeProposal?.current.winner.name;
	const mergeWinnerLabel =
		typeof mergeWinnerName === "string" && mergeWinnerName.trim().length > 0
			? mergeWinnerName
			: null;
	const mergeLoserLabel =
		mergeLosers.length === 1
			? mergeLosers[0]
			: mergeLosers.length > 1
				? `${mergeLosers.length} ${formatLabel(entityType ?? "entity").toLowerCase()} duplicates`
				: null;
	const mergeLabel =
		mergeLoserLabel && mergeWinnerLabel
			? `Merge ${mergeLoserLabel} into ${mergeWinnerLabel}`
			: mergeWinnerLabel
				? `Merge duplicate into ${mergeWinnerLabel}`
				: `Merge duplicate ${formatLabel(entityType ?? "entity").toLowerCase()}`;
	const actionLabel =
		operation === "update"
			? formatFieldChangeAction(entityType, fieldKeys)
			: operation === "delete"
				? `Delete ${entityType ? formatLabel(entityType).toLowerCase() : "entity"}`
				: operation === "merge"
					? mergeLabel
					: `Create ${formatLabel(entityType ?? "entity").toLowerCase()}`;

	const insertApprovalEvent = (runId: number, db: DbClient) =>
		insertEvent(
			{
				entityIds:
					operation === "create"
						? []
						: operation === "merge"
							? [
									...mergeEntityIds(asMergeProposal(proposal)),
									asMergeProposal(proposal).winner_entity_id,
								]
							: [changedEntityId(proposal)],
				organizationId: ctx.organizationId,
				originId: `run_${runId}_pending`,
				title: `${actionLabel} — pending approval`,
				content:
					proposal.reason ??
					(operation === "update"
						? `${actorNoun} proposed updating ${fieldList} on this entity.`
						: operation === "delete"
							? `${actorNoun} proposed deleting this entity.`
							: operation === "merge"
								? `${actorNoun} proposed merging these entities.`
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
							: mergeProposal
								? mergeProposal.current
								: null,
					proposal: createProposal
						? createProposal.proposal
						: mergeProposal
							? {
									entity_id: mergeProposal.entity_id,
									entity_ids: mergeEntityIds(mergeProposal),
									winner_entity_id: mergeProposal.winner_entity_id,
									evidence: mergeProposal.evidence ?? [],
									names: (
										mergeProposal.current.duplicates ?? [
											mergeProposal.current.loser,
										]
									).map((entity) => entity.name),
									name: mergeProposal.current.loser.name,
									winner_name: mergeProposal.current.winner.name,
								}
							: deleteProposal
								? {
										entity_id: deleteProposal.entity_id,
										entity_type:
											entity?.entity_type ?? deleteProposal.current.entity_type,
										name: entity?.name ?? deleteProposal.current.name,
										force_delete_tree:
											deleteProposal.force_delete_tree ?? false,
									}
								: null,
					watcher_id: proposal.watcher_id ?? null,
					watcher_name: watcherName,
					watcher_agent_id: watcherAgentId,
					// The run window this proposal belongs to, if any. Stamped so the UI can
					// tell this proposal is part of a BATCH (the change-set card owns the
					// Approve/Reject decision) and suppress this card's own duplicate buttons.
					window_id: windowId ?? null,
					entity_name: entityName ?? null,
					entity_type: entityType ?? null,
					entity_slug: createProposal ? null : (entity?.slug ?? null),
					parent_slug: createProposal ? null : (entity?.parent_slug ?? null),
					parent_entity_type: createProposal
						? null
						: (entity?.parent_entity_type ?? null),
					attribution,
					initiator: {
						kind: initiatorColumns.initiatorKind,
						...initiatorColumns.initiatorRef,
					},
					reason: proposal.reason ?? null,
					proposer_rationale: mergeProposal?.proposer_rationale ?? null,
					status: "pending_approval",
					run_id: runId,
					mcp_session_id: ctx.mcpSessionId ?? null,
				},
				authorName: attribution,
			},
			{ sql: db },
		);
	const reuseExisting = async (row: ExistingChangeRun, db: DbClient) => {
		await db`
			UPDATE runs
			SET idempotency_key = ${idempotencyKey}
			WHERE id = ${row.id} AND idempotency_key IS NULL
		`;
		const isPending =
			row.approval_status === "pending" && row.status === "pending";
		const eventId = isPending ? row.pending_event_id : row.current_event_id;
		if (eventId != null) {
			return {
				runId: Number(row.id),
				eventId: Number(eventId),
				reused: true,
			};
		}
		if (!isPending) {
			throw new Error(
				`Active entity change run ${row.id} has no approval event`,
			);
		}
		const event = await insertApprovalEvent(Number(row.id), db);
		return {
			runId: Number(row.id),
			eventId: Number(event.id),
			reused: false,
		};
	};

	const persisted = await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
		const existing = await findExisting(tx);
		if (existing.length > 0) {
			return reuseExisting(existing[0], tx);
		}

		const inserted = await tx<{ id: number }>`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input, window_id,
				watcher_id, created_by_user_id, initiator_kind, initiator_ref,
				approval_status, status, idempotency_key, created_at
			) VALUES (
				${ctx.organizationId}, 'internal', ${actionKey},
				${tx.json(actionInputProposal as unknown as Record<string, unknown>)},
				${windowId ?? null}, ${proposal.watcher_id ?? null},
				${initiatorColumns.createdByUserId},
				${initiatorColumns.initiatorKind},
				${tx.json(initiatorColumns.initiatorRef)},
				'pending', 'pending', ${idempotencyKey}, current_timestamp
			)
			ON CONFLICT DO NOTHING
			RETURNING id
		`;
		if (inserted.length === 0) {
			const winner = await findExisting(tx);
			if (winner.length === 0) {
				throw new Error("Entity change idempotency conflict has no active run");
			}
			return reuseExisting(winner[0], tx);
		}

		const runId = Number(inserted[0].id);
		const event = await insertApprovalEvent(runId, tx);
		return { runId, eventId: Number(event.id), reused: false };
	});
	const { runId, eventId } = persisted;

	const [permalinkRun] = await sql<{
		initiator_kind: string | null;
		initiator_ref: Record<string, unknown> | null;
		initiator_agent_id: string | null;
	}>`
		SELECT r.initiator_kind, r.initiator_ref, w.agent_id AS initiator_agent_id
		FROM runs r
		LEFT JOIN watchers w
			ON w.id = r.watcher_id AND w.organization_id = r.organization_id
		WHERE r.id = ${runId} AND r.organization_id = ${ctx.organizationId}
	`;
	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	// Run-scoped: the pending event is superseded on approve→complete; a run link
	// stays valid across the chain. (Read-side content_ids resolution also covers
	// the event id below, carried for the notification's resourceId.)
	// A Behavior-initiated proposal lands on that Behavior's drill-down instead
	// of the workspace-wide log, so the link answers where it came from.
	const approvalUrl = buildResourcePermalink(
		ownerSlug,
		runPermalinkResource(
			{
				initiatorKind: permalinkRun?.initiator_kind,
				initiatorRef: permalinkRun?.initiator_ref,
			},
			runId,
			permalinkRun?.initiator_agent_id,
		),
		baseUrl,
	);
	if (persisted.reused) return { runId, eventId, approvalUrl };
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
	// A single-field update can match a field-scoped delivery target; a
	// multi-field one falls back to the entity/type/global row rather than
	// arbitrarily routing by the first field.
	const approvalPolicy = await resolveEntityApprovalPolicy({
		organizationId: ctx.organizationId,
		entityTypeSlug: entityType ?? null,
		entityId:
			"entity_id" in proposal && typeof proposal.entity_id === "number"
				? proposal.entity_id
				: null,
		fieldPath:
			updateProposal && fieldKeys.length === 1 ? (fieldKeys[0] ?? null) : null,
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
		ownerUserId: updateProposal?.owner_user_id ?? null,
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
						entityId:
							deleteProposal?.entity_id ?? mergeProposal?.entity_id ?? null,
						entityType: entityType ?? null,
						entityName: entityName ?? null,
						entityUrl,
						proposal: mergeProposal
							? {
									entity_id: mergeProposal.entity_id,
									entity_ids: mergeEntityIds(mergeProposal),
									winner_entity_id: mergeProposal.winner_entity_id,
									evidence: mergeProposal.evidence ?? [],
									names: (
										mergeProposal.current.duplicates ?? [
											mergeProposal.current.loser,
										]
									).map((entity) => entity.name),
									name: mergeProposal.current.loser.name,
									winner_name: mergeProposal.current.winner.name,
								}
							: deleteProposal
								? {
										entity_id: deleteProposal.entity_id,
										entity_type:
											entity?.entity_type ?? deleteProposal.current.entity_type,
										name: entity?.name ?? deleteProposal.current.name,
										force_delete_tree:
											deleteProposal.force_delete_tree ?? false,
									}
								: (createProposal?.proposal ?? null),
						current: deleteProposal?.current ?? mergeProposal?.current ?? null,
						reason: proposal.reason ?? null,
					},
	}).catch((error) =>
		logger.error(error, "Failed to send entity change approval notification"),
	);

	return { runId, eventId, approvalUrl };
}

/** Reserved $-prefixed proposal keys that map to entity ATTRIBUTES, not metadata. */
const ATTRIBUTE_FIELD_KEYS = new Set(["$name", "$parent_id", "$content"]);

/**
 * Apply an approved field-change proposal. The approver endorsed the value, so
 * metadata fields are written AND marked human-owned via
 * mergeEntityFields(source='human'). Reserved $-attribute keys ($name,
 * $parent_id, $content) write the entity attribute directly — with the same
 * staleness guard: an attribute a human changed after the proposal was queued
 * is left alone.
 */
export async function applyEntityFieldChangeProposal(
	proposal: EntityFieldChangeProposal,
	approverUserId: string | null,
): Promise<FieldMergeResult> {
	const sql = getDb();
	const metadataFields = Object.fromEntries(
		Object.entries(proposal.fields).filter(
			([key]) => !ATTRIBUTE_FIELD_KEYS.has(key),
		),
	);
	const attributeFields = Object.fromEntries(
		Object.entries(proposal.fields).filter(([key]) =>
			ATTRIBUTE_FIELD_KEYS.has(key),
		),
	);
	return await sql.begin(async (tx) => {
		const merge =
			Object.keys(metadataFields).length > 0
				? await mergeEntityFields({
						tx,
						entityId: proposal.entity_id,
						fields: metadataFields,
						source: "human",
						actorId: approverUserId,
						note: proposal.reason ?? null,
						// Don't overwrite a field the human re-edited after this proposal was queued.
						expectedCurrent: proposal.current ?? null,
					})
				: ({
						changed: false,
						applied: {},
						blocked: {},
						stale: {},
						affirmed: [],
						nextMetadata: {},
						nextControls: {},
					} satisfies FieldMergeResult);
		if (Object.keys(attributeFields).length > 0) {
			const rows = await tx<{
				name: string | null;
				parent_id: number | null;
				content: string | null;
			}>`
        SELECT name, parent_id, content FROM entities
        WHERE id = ${proposal.entity_id} AND deleted_at IS NULL
        FOR UPDATE
      `;
			if (rows.length === 0) {
				throw new Error(`Entity ${proposal.entity_id} not found`);
			}
			const live = {
				$name: rows[0].name ?? null,
				$parent_id:
					rows[0].parent_id == null ? null : Number(rows[0].parent_id),
				$content: rows[0].content ?? null,
			} as Record<string, unknown>;
			const apply: Record<string, unknown> = {};
			for (const [key, proposed] of Object.entries(attributeFields)) {
				const expected = proposal.current?.[key];
				if (
					proposal.current &&
					Object.hasOwn(proposal.current, key) &&
					JSON.stringify(live[key] ?? null) !== JSON.stringify(expected ?? null)
				) {
					merge.stale[key] = {
						expected: expected ?? null,
						live: live[key] ?? null,
					};
					continue;
				}
				apply[key] = proposed;
				merge.applied[key] = { old: live[key] ?? null, new: proposed };
			}
			if (Object.keys(apply).length > 0) {
				const nextName =
					"$name" in apply ? String(apply.$name ?? "") || null : null;
				await tx`
          UPDATE entities SET
            name = COALESCE(${nextName}, name),
            parent_id = CASE WHEN ${"$parent_id" in apply} THEN ${
							("$parent_id" in apply ? apply.$parent_id : null) as number | null
						}::bigint ELSE parent_id END,
            content = CASE WHEN ${"$content" in apply} THEN ${
							"$content" in apply ? (apply.$content as string | null) : null
						} ELSE content END,
            updated_at = current_timestamp
          WHERE id = ${proposal.entity_id} AND deleted_at IS NULL
        `;
			}
		}
		return merge;
	});
}

export async function applyEntityChangeProposal(
	proposal: EntityChangeProposal,
	ctx: ToolContext,
	env: Env,
	db: DbClient,
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
			{
				...createProposal.entity_data,
				organization_id: ctx.organizationId,
				// The watcher that PROPOSED the create is not a real user row, so
				// entities.created_by (NOT NULL, FK → user) must attribute the create to
				// the human who APPROVED it. Approval is human-gated (requireHuman-
				// ApprovalContext), so ctx.userId is a verified user here — using it
				// avoids the "system" fallback that fails the FK.
				created_by: ctx.userId ?? createProposal.entity_data.created_by,
			},
			{
				hookContext: {
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					env,
				},
			},
		);
	}
	if (operation === "merge") {
		const mergeProposal = asMergeProposal(proposal);
		if (mergeProposal.resolution_fingerprint) {
			await assertResolutionFingerprintCurrent(db, {
				organizationId: ctx.organizationId,
				winnerId: mergeProposal.winner_entity_id,
				loserIds: mergeEntityIds(mergeProposal),
				expectedFingerprint: mergeProposal.resolution_fingerprint,
			});
		}
		const params = {
			orgId: ctx.organizationId,
			loserIds: mergeEntityIds(mergeProposal),
			winnerId: mergeProposal.winner_entity_id,
			mergedBy: ctx.userId ?? "system",
			resolution: {
				decision: "human" as const,
				sourceRunId: mergeProposal.source_run_id ?? null,
				watcherId: mergeProposal.watcher_id ?? null,
				windowId:
					mergeProposal.source_window_id ?? mergeProposal.window_id ?? null,
				policyHash: mergeProposal.policy_hash ?? null,
				evidence: mergeProposal.evidence ?? [],
			},
		};
		return applyMergeGroupInTransaction(params, db);
	}
	const deleteProposal = asDeleteProposal(proposal);
	return deleteEntity(
		deleteProposal.entity_id,
		deleteProposal.force_delete_tree ?? false,
		env,
		ctx,
	);
}
