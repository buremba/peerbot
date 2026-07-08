import { type DbClient, getDb } from "../db/client";
import type { EntityPolicyPrincipalKind } from "./entity-policy";

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
	createMode: EntityMutationMode;
	updateMode: EntityMutationMode;
	deleteMode: EntityMutationMode;
	deliveryTarget: EntityApprovalDeliveryTarget;
}

export interface EntityApprovalPolicyInput {
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
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
	create_mode: string;
	update_mode: string;
	delete_mode: string;
	approval_connection_id: string | null;
	approval_channel_id: string | null;
	approval_team_id: string | null;
	approval_channel_name: string | null;
};

export interface AvailableApprovalChannel {
	connectionId: string;
	platform: string;
	channelId: string;
	teamId: string | null;
	label: string;
}

function isMutationMode(value: unknown): value is EntityMutationMode {
	return value === "auto" || value === "approval";
}

function normalizeMode(
	value: unknown,
	fallback: EntityMutationMode,
): EntityMutationMode {
	return isMutationMode(value) ? value : fallback;
}

function normalizeConnectionId(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	return String(value);
}

function rowToPolicy(row: EntityApprovalPolicyRow): EntityApprovalPolicy {
	return {
		id: Number(row.id),
		organizationId: row.organization_id,
		entityTypeSlug: row.entity_type_slug,
		fieldPath: row.field_path,
		createMode: normalizeMode(row.create_mode, "auto"),
		updateMode: normalizeMode(row.update_mode, "auto"),
		deleteMode: normalizeMode(row.delete_mode, "approval"),
		deliveryTarget: {
			connectionId: normalizeConnectionId(row.approval_connection_id),
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

function modeForAction(
	policy: EntityApprovalPolicy,
	action: EntityMutationAction,
): EntityMutationMode {
	if (action === "create") return policy.createMode;
	if (action === "update") return policy.updateMode;
	return policy.deleteMode;
}

export async function resolveEntityApprovalPolicy(args: {
	organizationId: string;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicy> {
	const sql = args.sql ?? getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, entity_type_slug, field_path,
           create_mode, update_mode, delete_mode,
           approval_connection_id, approval_channel_id, approval_team_id,
           approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND (entity_type_slug IS NULL OR entity_type_slug = ${args.entityTypeSlug ?? null})
      AND (field_path IS NULL OR field_path = ${args.fieldPath ?? null})
    ORDER BY
      CASE WHEN entity_type_slug IS NULL THEN 0 ELSE 1 END DESC,
      CASE WHEN field_path IS NULL THEN 0 ELSE 1 END DESC,
      id DESC
    LIMIT 1
  `;

	return rows[0]
		? rowToPolicy(rows[0])
		: defaultEntityApprovalPolicy(args.organizationId);
}

export async function shouldRequireEntityMutationApproval(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	action: EntityMutationAction;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	defaultRequiresApproval: boolean;
	sql?: DbClient;
}): Promise<boolean> {
	if (args.principalKind === "user") return false;
	const policy = await resolveEntityApprovalPolicy(args);
	const mode = modeForAction(policy, args.action);
	if (mode === "approval") return true;
	return args.defaultRequiresApproval;
}

export async function getGlobalEntityApprovalPolicy(
	organizationId: string,
): Promise<EntityApprovalPolicy> {
	const sql = getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, entity_type_slug, field_path,
           create_mode, update_mode, delete_mode,
           approval_connection_id, approval_channel_id, approval_team_id,
           approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${organizationId}
      AND entity_type_slug IS NULL
      AND field_path IS NULL
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
    SELECT id, organization_id, entity_type_slug, field_path,
           create_mode, update_mode, delete_mode,
           approval_connection_id, approval_channel_id, approval_team_id,
           approval_channel_name
    FROM entity_approval_policies
    WHERE organization_id = ${organizationId}
    ORDER BY
      CASE WHEN entity_type_slug IS NULL THEN 0 ELSE 1 END,
      entity_type_slug ASC NULLS FIRST,
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
	});
}

export async function upsertEntityApprovalPolicy(
	organizationId: string,
	input: EntityApprovalPolicyInput,
): Promise<EntityApprovalPolicy> {
	const entityTypeSlug = input.entityTypeSlug?.trim() || null;
	const fieldPath = input.fieldPath?.trim() || null;
	const createMode = normalizeMode(input.createMode, "auto");
	const updateMode = normalizeMode(input.updateMode, "auto");
	const deleteMode = normalizeMode(input.deleteMode, "approval");
	const approvalConnectionId = normalizeConnectionId(
		input.approvalConnectionId,
	);
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
      RETURNING id, organization_id, entity_type_slug, field_path,
                create_mode, update_mode, delete_mode,
                approval_connection_id, approval_channel_id, approval_team_id,
                approval_channel_name
    `;
		if (updated[0]) return updated[0];

		const inserted = await tx<EntityApprovalPolicyRow>`
      INSERT INTO entity_approval_policies (
        organization_id, entity_type_slug, field_path,
        create_mode, update_mode, delete_mode,
        approval_connection_id, approval_channel_id, approval_team_id,
        approval_channel_name, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${entityTypeSlug}, ${fieldPath},
        ${createMode}, ${updateMode}, ${deleteMode},
        ${approvalConnectionId},
        ${approvalChannelId}, ${approvalTeamId}, ${approvalChannelName},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id, organization_id, entity_type_slug, field_path,
                create_mode, update_mode, delete_mode,
                approval_connection_id, approval_channel_id, approval_team_id,
                approval_channel_name
    `;
		if (inserted[0]) return inserted[0];

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
      RETURNING id, organization_id, entity_type_slug, field_path,
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
}): Promise<boolean> {
	const entityTypeSlug = args.entityTypeSlug?.trim() || null;
	const fieldPath = args.fieldPath?.trim() || null;
	if (!entityTypeSlug && !fieldPath) return false;
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    DELETE FROM entity_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
      AND field_path IS NOT DISTINCT FROM ${fieldPath}
    RETURNING id
  `;
	return rows.length > 0;
}
