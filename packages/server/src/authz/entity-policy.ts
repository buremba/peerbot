/**
 * Entity mutation policy — the single decision layer for whether an agent or
 * watcher write to an entity applies immediately or queues a durable approval.
 *
 * Two inputs, one decision:
 *  - Built-in invariants that no org policy can disable: writes never cross
 *    organizations, and a non-human write to a human-owned field always needs
 *    approval (field ownership is how a user pins a value).
 *  - The org's persisted `entity_approval_policies` rows: per-action
 *    auto/approval modes, scoped global → entity type → field → single entity
 *    (entity_id), most specific row wins. Rows also carry the Slack delivery
 *    target for approval notifications.
 *
 * Human edits are never gated here — role restrictions for humans live in the
 * tool-access tier (e.g. manage_entity delete is owner/admin).
 *
 * Gated paths: manage_entity create/update/delete and watcher window promotion
 * (promote-keyed-entities). Ingestion-infrastructure writes (entity-link-upsert
 * identity stubs, classifier extraction) are exempt BY DESIGN — they are
 * high-volume provenance plumbing, not collaboration edits; gating them would
 * flood approvals. Any new user-facing entity write path MUST call this module.
 */
import { type DbClient, getDb } from "../db/client";

export type EntityPolicyDecision = "allow" | "deny" | "require_approval";
export type EntityPolicyPrincipalKind = "user" | "agent" | "watcher";
export type EntityMutationAction = "create" | "update" | "delete";
export type EntityMutationMode = "auto" | "approval";

export interface EntityApprovalDeliveryTarget {
	connectionId: string | null;
	channelId: string | null;
	teamId: string | null;
	channelName: string | null;
}

export interface EntityApprovalPolicy {
	id: number;
	organizationId: string;
	entityTypeSlug: string | null;
	fieldPath: string | null;
	entityId: number | null;
	createMode: EntityMutationMode;
	updateMode: EntityMutationMode;
	deleteMode: EntityMutationMode;
	deliveryTarget: EntityApprovalDeliveryTarget;
}

export interface EntityApprovalPolicyInput {
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	createMode?: EntityMutationMode;
	updateMode?: EntityMutationMode;
	deleteMode?: EntityMutationMode;
	approvalConnectionId?: string | null;
	approvalChannelId?: string | null;
	approvalTeamId?: string | null;
	approvalChannelName?: string | null;
}

type EntityApprovalPolicyRow = {
	id: number;
	organization_id: string;
	entity_type_slug: string | null;
	field_path: string | null;
	entity_id: number | null;
	create_mode: string;
	update_mode: string;
	delete_mode: string;
	approval_connection_id: string | null;
	approval_channel_id: string | null;
	approval_team_id: string | null;
	approval_channel_name: string | null;
};

export function isEntityMutationMode(
	value: unknown,
): value is EntityMutationMode {
	return value === "auto" || value === "approval";
}

function normalizeMode(
	value: unknown,
	fallback: EntityMutationMode,
): EntityMutationMode {
	return isEntityMutationMode(value) ? value : fallback;
}

function rowToPolicy(row: EntityApprovalPolicyRow): EntityApprovalPolicy {
	return {
		id: Number(row.id),
		organizationId: row.organization_id,
		entityTypeSlug: row.entity_type_slug,
		fieldPath: row.field_path,
		entityId: row.entity_id === null ? null : Number(row.entity_id),
		createMode: normalizeMode(row.create_mode, "auto"),
		updateMode: normalizeMode(row.update_mode, "auto"),
		deleteMode: normalizeMode(row.delete_mode, "approval"),
		deliveryTarget: {
			connectionId: row.approval_connection_id || null,
			channelId: row.approval_channel_id,
			teamId: row.approval_team_id,
			channelName: row.approval_channel_name,
		},
	};
}

export function defaultEntityApprovalPolicy(
	organizationId: string,
): EntityApprovalPolicy {
	return {
		id: 0,
		organizationId,
		entityTypeSlug: null,
		fieldPath: null,
		entityId: null,
		createMode: "auto",
		updateMode: "auto",
		deleteMode: "approval",
		deliveryTarget: {
			connectionId: null,
			channelId: null,
			teamId: null,
			channelName: null,
		},
	};
}

/**
 * Who is performing this mutation, for policy purposes. A watcher-attributed
 * call is a watcher; a real user session (userId without an agent run) is a
 * human; everything else — agent runs, automation/system tokens — is an agent.
 * Used identically by create, update, and delete gates so a system context
 * can neither bypass policy (as a fake "user") nor get spuriously denied.
 */
export function classifyMutationPrincipal(args: {
	userId?: string | null;
	agentId?: string | null;
	watcherSource?: unknown;
}): EntityPolicyPrincipalKind {
	if (args.watcherSource) return "watcher";
	if (args.userId && !args.agentId) return "user";
	return "agent";
}

function modeForAction(
	policy: EntityApprovalPolicy,
	action: EntityMutationAction,
): EntityMutationMode {
	if (action === "create") return policy.createMode;
	if (action === "update") return policy.updateMode;
	return policy.deleteMode;
}

function specificity(row: EntityApprovalPolicyRow): number {
	return (
		(row.entity_id !== null ? 4 : 0) +
		(row.field_path !== null ? 2 : 0) +
		(row.entity_type_slug !== null ? 1 : 0)
	);
}

/** All policy rows that could match this entity type / entity, most specific first. */
async function loadCandidatePolicies(args: {
	organizationId: string;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicyRow[]> {
	const sql = args.sql ?? getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND (entity_type_slug IS NULL OR entity_type_slug = ${args.entityTypeSlug ?? null})
      AND (entity_id IS NULL OR entity_id = ${args.entityId ?? null})
  `;
	return [...rows].sort((a, b) => specificity(b) - specificity(a));
}

function pickPolicy(
	candidates: EntityApprovalPolicyRow[],
	organizationId: string,
	fieldPath: string | null,
): EntityApprovalPolicy {
	const match = candidates.find(
		(row) => row.field_path === null || row.field_path === fieldPath,
	);
	if (!match) return defaultEntityApprovalPolicy(organizationId);
	const policy = rowToPolicy(match);
	// Scoped rows don't carry their own channel — inherit the workspace
	// default's delivery target so scoped approvals still land in the
	// configured channel rather than falling back to generic admin fan-out.
	if (!policy.deliveryTarget.connectionId && !policy.deliveryTarget.channelId) {
		const global = candidates.find(
			(row) =>
				row.entity_type_slug === null &&
				row.field_path === null &&
				row.entity_id === null,
		);
		if (global) {
			policy.deliveryTarget = rowToPolicy(global).deliveryTarget;
		}
	}
	return policy;
}

/**
 * The policy row governing one prospective mutation (used both for the
 * approval decision and for the Slack delivery target of the approval card).
 */
export async function resolveEntityApprovalPolicy(args: {
	organizationId: string;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicy> {
	const candidates = await loadCandidatePolicies(args);
	return pickPolicy(candidates, args.organizationId, args.fieldPath ?? null);
}

/**
 * Decision for a create or delete. `entityOrgId` is the org of the row being
 * touched (from the locked/fetched entity); a mismatch is always a deny.
 */
export async function evaluateEntityMutation(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	action: EntityMutationAction;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	entityOrgId?: string | null;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	if (args.entityOrgId && args.entityOrgId !== args.organizationId) {
		return "deny";
	}
	if (args.principalKind === "user") return "allow";
	const policy = await resolveEntityApprovalPolicy(args);
	return modeForAction(policy, args.action) === "approval"
		? "require_approval"
		: "allow";
}

/**
 * Per-field decisions for a non-human update, from ONE policy query. A field
 * needs approval when the matched policy says so, or — regardless of policy —
 * when the field is human-owned.
 */
export async function evaluateEntityFieldUpdates(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	entityTypeSlug: string;
	entityId: number;
	entityOrgId?: string | null;
	/** field path -> current owner ("human" pins the field). */
	fields: Record<string, "human" | "none">;
	sql?: DbClient;
}): Promise<Record<string, EntityPolicyDecision>> {
	const decisions: Record<string, EntityPolicyDecision> = {};
	if (args.entityOrgId && args.entityOrgId !== args.organizationId) {
		for (const field of Object.keys(args.fields)) decisions[field] = "deny";
		return decisions;
	}
	if (args.principalKind === "user") {
		for (const field of Object.keys(args.fields)) decisions[field] = "allow";
		return decisions;
	}
	const candidates = await loadCandidatePolicies(args);
	for (const [field, owner] of Object.entries(args.fields)) {
		const policy = pickPolicy(candidates, args.organizationId, field);
		decisions[field] =
			owner === "human" || policy.updateMode === "approval"
				? "require_approval"
				: "allow";
	}
	return decisions;
}

export async function getGlobalEntityApprovalPolicy(
	organizationId: string,
): Promise<EntityApprovalPolicy> {
	const sql = getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${organizationId}
      AND entity_type_slug IS NULL
      AND field_path IS NULL
      AND entity_id IS NULL
    LIMIT 1
  `;
	return rows[0]
		? rowToPolicy(rows[0])
		: defaultEntityApprovalPolicy(organizationId);
}

export async function listEntityApprovalPolicies(
	organizationId: string,
): Promise<EntityApprovalPolicy[]> {
	const sql = getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${organizationId}
    ORDER BY
      CASE WHEN entity_type_slug IS NULL THEN 0 ELSE 1 END,
      entity_type_slug ASC NULLS FIRST,
      CASE WHEN entity_id IS NULL THEN 0 ELSE 1 END,
      entity_id ASC NULLS FIRST,
      CASE WHEN field_path IS NULL THEN 0 ELSE 1 END,
      field_path ASC NULLS FIRST,
      id ASC
  `;
	return rows.map(rowToPolicy);
}

export async function upsertGlobalEntityApprovalPolicy(
	organizationId: string,
	input: EntityApprovalPolicyInput,
): Promise<EntityApprovalPolicy> {
	return upsertEntityApprovalPolicy(organizationId, {
		...input,
		entityTypeSlug: null,
		fieldPath: null,
		entityId: null,
	});
}

export async function upsertEntityApprovalPolicy(
	organizationId: string,
	input: EntityApprovalPolicyInput,
): Promise<EntityApprovalPolicy> {
	const entityTypeSlug = input.entityTypeSlug?.trim() || null;
	const fieldPath = input.fieldPath?.trim() || null;
	const entityId = input.entityId ?? null;
	const createMode = normalizeMode(input.createMode, "auto");
	const updateMode = normalizeMode(input.updateMode, "auto");
	const deleteMode = normalizeMode(input.deleteMode, "approval");
	const approvalConnectionId = input.approvalConnectionId?.trim() || null;
	const approvalChannelId = input.approvalChannelId?.trim() || null;
	const approvalTeamId = input.approvalTeamId?.trim() || null;
	const approvalChannelName = input.approvalChannelName?.trim() || null;

	const sql = getDb();
	const row = await sql.begin(async (tx) => {
		const updated = await tx<EntityApprovalPolicyRow>`
      UPDATE entity_approval_policies
      SET create_mode = ${createMode},
          update_mode = ${updateMode},
          delete_mode = ${deleteMode},
          approval_connection_id = ${approvalConnectionId},
          approval_channel_id = ${approvalChannelId},
          approval_team_id = ${approvalTeamId},
          approval_channel_name = ${approvalChannelName},
          updated_at = now()
      WHERE organization_id = ${organizationId}
        AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
        AND field_path IS NOT DISTINCT FROM ${fieldPath}
        AND entity_id IS NOT DISTINCT FROM ${entityId}
      RETURNING id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;
		if (updated[0]) return updated[0];

		const inserted = await tx<EntityApprovalPolicyRow>`
      INSERT INTO entity_approval_policies (
        organization_id, entity_type_slug, field_path, entity_id,
        create_mode, update_mode, delete_mode,
        approval_connection_id, approval_channel_id, approval_team_id,
        approval_channel_name, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${entityTypeSlug}, ${fieldPath}, ${entityId},
        ${createMode}, ${updateMode}, ${deleteMode},
        ${approvalConnectionId},
        ${approvalChannelId}, ${approvalTeamId}, ${approvalChannelName},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;
		if (inserted[0]) return inserted[0];

		// Lost the insert race to a concurrent save — apply this request on top.
		const selected = await tx<EntityApprovalPolicyRow>`
      UPDATE entity_approval_policies
      SET create_mode = ${createMode},
          update_mode = ${updateMode},
          delete_mode = ${deleteMode},
          approval_connection_id = ${approvalConnectionId},
          approval_channel_id = ${approvalChannelId},
          approval_team_id = ${approvalTeamId},
          approval_channel_name = ${approvalChannelName},
          updated_at = now()
      WHERE organization_id = ${organizationId}
        AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
        AND field_path IS NOT DISTINCT FROM ${fieldPath}
        AND entity_id IS NOT DISTINCT FROM ${entityId}
      RETURNING id, organization_id, entity_type_slug, field_path, entity_id,
       create_mode, update_mode, delete_mode,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;
		return selected[0] ?? null;
	});
	if (!row) throw new Error("Failed to save entity approval policy");
	return rowToPolicy(row);
}

export async function deleteEntityApprovalPolicy(args: {
	organizationId: string;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
}): Promise<boolean> {
	const entityTypeSlug = args.entityTypeSlug?.trim() || null;
	const fieldPath = args.fieldPath?.trim() || null;
	const entityId = args.entityId ?? null;
	if (!entityTypeSlug && !fieldPath && entityId === null) return false;
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    DELETE FROM entity_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
      AND field_path IS NOT DISTINCT FROM ${fieldPath}
      AND entity_id IS NOT DISTINCT FROM ${entityId}
    RETURNING id
  `;
	return rows.length > 0;
}
