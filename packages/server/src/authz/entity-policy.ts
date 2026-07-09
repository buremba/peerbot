/**
 * Entity mutation policy — the single decision layer for whether an agent or
 * watcher write to an entity applies immediately or queues a durable approval.
 *
 * Two inputs, one decision:
 *  - Built-in invariants that no org policy can disable: writes never cross
 *    organizations, and a non-human write to a human-owned field always needs
 *    approval (field ownership is how a user pins a value).
 *  - The org's persisted `write_approval_policies` rows: per-action
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
import { type DbClient, getDb, pgBigintArray } from "../db/client";
import {
	type WriteAction,
	defaultEffectFor,
	isLegalActionEffect,
} from "./write-action-manifest";

export type EntityPolicyDecision = "allow" | "deny" | "require_approval";
export type EntityPolicyPrincipalKind = "user" | "agent" | "watcher";
export type EntityMutationAction = "create" | "update" | "delete";
/**
 * A stored per-action mode. `auto`/`approval` are the two entity modes; `deny`
 * (a hard floor — the write never applies and no approval is queued) and
 * `disabled` (the action is turned off entirely, used by the connector-action
 * class) are admitted by the widened DB CHECK. The resolver maps each to an
 * {@link EntityPolicyDecision}; unknown values coerce to the caller's fallback
 * so a mode this build predates can never silently read as `allow`.
 */
export type EntityMutationMode = "auto" | "approval" | "deny" | "disabled";

/**
 * Which class of write a policy row governs. `entity` is the original class;
 * `agent_config` gates manage_agents create/update/delete; `connector_action`
 * gates connector operation execution. All three share this table + resolver so a
 * new class is a value, not a schema change (see docs/plans/write-gate-generalization.md).
 */
export type WriteResourceClass = "entity" | "agent_config" | "connector_action";

/** A non-human principal a policy row may target. NULL principal = any of this kind. */
export type PolicyPrincipalKind = "agent" | "watcher";

export interface EntityApprovalDeliveryTarget {
	connectionId: string | null;
	channelId: string | null;
	teamId: string | null;
	channelName: string | null;
}

export interface EntityApprovalPolicy {
	id: number;
	organizationId: string;
	resourceClass: WriteResourceClass;
	/** Non-human principal this row targets; NULL = any principal of its kind. */
	principalKind: PolicyPrincipalKind | null;
	principalId: string | null;
	entityTypeSlug: string | null;
	fieldPath: string | null;
	entityId: number | null;
	createMode: EntityMutationMode;
	updateMode: EntityMutationMode;
	deleteMode: EntityMutationMode;
	/**
	 * The effect this policy attaches to each action it declares, from the child
	 * write_policy_action_effects rows. The create/update/delete convenience
	 * fields above mirror this map (entity/agent_config); connector_action carries
	 * only `execute` here and leaves the mode fields at their class defaults.
	 */
	effects: Partial<Record<WriteAction, EntityMutationMode>>;
	deliveryTarget: EntityApprovalDeliveryTarget;
}

export interface EntityApprovalPolicyInput {
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
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

/**
 * A header row from write_approval_policies, with its child action→effect rows
 * attached in `effects` by {@link attachEffects}. The header no longer carries
 * mode columns; every per-action decision reads `effects`.
 */
type EntityApprovalPolicyRow = {
	id: number;
	organization_id: string;
	resource_class: string;
	principal_kind: string | null;
	principal_id: string | null;
	entity_type_slug: string | null;
	field_path: string | null;
	entity_id: number | null;
	approval_connection_id: string | null;
	approval_channel_id: string | null;
	approval_team_id: string | null;
	approval_channel_name: string | null;
	/** Populated post-query from write_policy_action_effects; empty until attached. */
	effects: Partial<Record<WriteAction, EntityMutationMode>>;
};


export function isEntityMutationMode(
	value: unknown,
): value is EntityMutationMode {
	return (
		value === "auto" ||
		value === "approval" ||
		value === "deny" ||
		value === "disabled"
	);
}

/** The two modes the entity-approval UI/API accept for create/update/delete. */
export function isEntityApprovalUiMode(value: unknown): value is "auto" | "approval" {
	return value === "auto" || value === "approval";
}

/**
 * Coerce user INPUT to a caller-chosen default when it isn't a legal mode.
 * (Stored effects READ from the DB fail closed differently — see
 * {@link attachEffects}, which drops an illegal (action, effect) tuple so the
 * resolver falls back to the class default rather than reading it as `allow`.)
 */
function normalizeMode(
	value: unknown,
	fallback: EntityMutationMode,
): EntityMutationMode {
	return isEntityMutationMode(value) ? value : fallback;
}

function normalizeResourceClass(value: unknown): WriteResourceClass {
	if (value === "agent_config") return "agent_config";
	if (value === "connector_action") return "connector_action";
	return "entity";
}

function normalizePrincipalKind(value: unknown): PolicyPrincipalKind | null {
	return value === "agent" || value === "watcher" ? value : null;
}

/**
 * The stored effect a policy attaches to `action`, or the class default if the
 * policy declares no row for that action. A policy is a SPARSE override: a scope
 * that sets only `execute` (or only `delete`) leaves the other actions at their
 * class default rather than implicitly `auto`.
 */
function effectForRowAction(
	row: EntityApprovalPolicyRow,
	resourceClass: WriteResourceClass,
	action: WriteAction,
): EntityMutationMode {
	const stored = row.effects[action];
	if (stored !== undefined) return stored;
	return defaultEffectFor(resourceClass, action);
}

function rowToPolicy(row: EntityApprovalPolicyRow): EntityApprovalPolicy {
	const resourceClass = normalizeResourceClass(row.resource_class);
	return {
		id: Number(row.id),
		organizationId: row.organization_id,
		resourceClass,
		principalKind: normalizePrincipalKind(row.principal_kind),
		principalId: row.principal_id,
		entityTypeSlug: row.entity_type_slug,
		fieldPath: row.field_path,
		entityId: row.entity_id === null ? null : Number(row.entity_id),
		createMode: effectForRowAction(row, resourceClass, "create"),
		updateMode: effectForRowAction(row, resourceClass, "update"),
		deleteMode: effectForRowAction(row, resourceClass, "delete"),
		effects: { ...row.effects },
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
		resourceClass: "entity",
		principalKind: null,
		principalId: null,
		entityTypeSlug: null,
		fieldPath: null,
		entityId: null,
		createMode: "auto",
		updateMode: "auto",
		deleteMode: "approval",
		effects: { create: "auto", update: "auto", delete: "approval" },
		deliveryTarget: {
			connectionId: null,
			channelId: null,
			teamId: null,
			channelName: null,
		},
	};
}

/**
 * Who is performing this mutation, for policy purposes. Precedence is DELIBERATE
 * and security-relevant: a real agent run (trusted `agentId` on the context) is
 * classified as an agent EVEN IF the request also carries a `watcher_source`.
 * `watcher_source` is a caller-supplied arg (attribution, e.g. for card labels);
 * letting it override the trusted agent identity would let an agent escape its
 * own per-principal policy by tagging its write as a watcher's. A genuine watcher
 * promotion runs with no agentId, so it still classifies as a watcher. A real
 * user session (userId, no agentId) is a human; everything else is an agent.
 */
export function classifyMutationPrincipal(args: {
	userId?: string | null;
	agentId?: string | null;
	watcherSource?: unknown;
}): EntityPolicyPrincipalKind {
	// Trusted agent identity wins over the caller-supplied watcher tag.
	if (args.agentId) return "agent";
	if (args.watcherSource) return "watcher";
	if (args.userId) return "user";
	return "agent";
}

/**
 * Stable identity of the acting non-human principal, for per-principal policy
 * matching. Mirrors {@link classifyMutationPrincipal}'s precedence: a trusted
 * `agentId` wins — an agent run resolves to its own agent id even when a
 * `watcherId` (from a caller-supplied watcher_source) is also present, so it
 * can't spoof `watcher:<id>` to dodge its agent policy. Only a genuine watcher
 * path (agentId null) resolves to `watcher:<id>`; no id → null ("any agent").
 */
export function mutationPrincipalId(args: {
	agentId?: string | null;
	watcherId?: number | null;
}): string | null {
	if (args.agentId) return args.agentId;
	if (args.watcherId != null) return `watcher:${args.watcherId}`;
	return null;
}

/**
 * The effect this resolved policy attaches to `action`. Reads the policy's
 * action→effect map, falling back to the class default for an action the policy
 * declares no row for (a sparse override). Works for every action a class
 * governs — including connector_action's `execute`, which the old positional
 * switch could not express.
 */
function modeForAction(
	policy: EntityApprovalPolicy,
	action: WriteAction,
): EntityMutationMode {
	const stored = policy.effects[action];
	if (stored !== undefined) return stored;
	return defaultEffectFor(policy.resourceClass, action);
}

/**
 * The winning mode's effect on a mutation. `deny` and `disabled` both stop the
 * write with no approval queued; `approval` queues one; `auto` applies inline.
 * Centralized so the create/delete and per-field update paths agree — and so a
 * future mode can never be read as `allow` by omission.
 */
function modeToDecision(mode: EntityMutationMode): EntityPolicyDecision {
	if (mode === "deny" || mode === "disabled") return "deny";
	if (mode === "approval") return "require_approval";
	return "allow";
}

/**
 * Target-scope specificity: entity_id > field_path > entity_type > global. Weights
 * are strictly ordered so a more-specific scope always outranks a broader one.
 */
function scopeSpecificity(row: EntityApprovalPolicyRow): number {
	return (
		(row.entity_id !== null ? 4 : 0) +
		(row.field_path !== null ? 2 : 0) +
		(row.entity_type_slug !== null ? 1 : 0)
	);
}

/** Principal specificity: exact id > kind-wide > any. Used only to break scope ties. */
function principalSpecificity(row: EntityApprovalPolicyRow): number {
	return row.principal_id !== null ? 2 : row.principal_kind !== null ? 1 : 0;
}

/** Restrictive rank of a single stored mode — higher = more restrictive. */
function modeRestrictiveness(mode: EntityMutationMode): number {
	if (mode === "deny") return 3;
	if (mode === "disabled") return 3;
	if (mode === "approval") return 2;
	return 1; // auto
}

/**
 * A row's overall restrictiveness, for the final tie-break: the most restrictive
 * of its declared per-action effects. Ensures that when scope AND principal
 * specificity tie, the stricter row wins (deny > approval > auto) rather than
 * DB-return order. A row with no declared effects (shouldn't occur — every saved
 * scope writes a complete action set) ranks least-restrictive.
 */
function rowRestrictiveness(row: EntityApprovalPolicyRow): number {
	const effects = Object.values(row.effects);
	if (effects.length === 0) return modeRestrictiveness("auto");
	return Math.max(...effects.map((e) => modeRestrictiveness(e)));
}

/**
 * Order candidate rows most-authoritative first, per the RFC's declared ordering
 * (docs/plans/write-gate-generalization.md §4): TARGET SCOPE specificity first,
 * THEN principal specificity, then restrictive-wins as the final tie-break. So an
 * entity-type `deny` beats an agent-global `auto` — a broad per-principal row can
 * never shadow a narrowly-scoped rule. `id` last makes the order deterministic.
 */
function compareCandidates(
	a: EntityApprovalPolicyRow,
	b: EntityApprovalPolicyRow,
): number {
	return (
		scopeSpecificity(b) - scopeSpecificity(a) ||
		principalSpecificity(b) - principalSpecificity(a) ||
		rowRestrictiveness(b) - rowRestrictiveness(a) ||
		Number(b.id) - Number(a.id)
	);
}

/**
 * All policy rows that could match this write, most specific first. Filters by
 * resource class (default `entity`) and by principal: a row applies when it
 * targets no principal (any), or targets this principal's kind and either no
 * specific id (any of that kind) or exactly this id.
 */
type ActionEffectRow = { policy_id: number; action: string; effect: string };

/**
 * Attach each header row's child action→effect rows in one batched query (keyed
 * by policy_id, no N+1).
 *
 * Fail-closed on a bad STORED value: when a child row exists for an action but
 * carries an effect this build can't recognize or the manifest declares illegal
 * for the class (a value a future build introduced mid-rolling-upgrade, or
 * corrupt data from manual SQL), the action is pinned to `deny` — never silently
 * dropped. Dropping would let the resolver fall back to the class default (which
 * for entity create is `auto`), reading a stored-but-unknown value as `allow`.
 * An ABSENT action (no child row at all) is different: that's a sparse override,
 * and it correctly inherits the class default.
 */
async function attachEffects(
	sql: DbClient,
	rows: EntityApprovalPolicyRow[],
): Promise<EntityApprovalPolicyRow[]> {
	for (const row of rows) row.effects = {};
	if (rows.length === 0) return rows;
	const byId = new Map(rows.map((r) => [Number(r.id), r]));
	const ids = rows.map((r) => Number(r.id));
	const effects = await sql<ActionEffectRow>`
    SELECT policy_id, action, effect
    FROM write_policy_action_effects
    WHERE policy_id = ANY(${pgBigintArray(ids)})
  `;
	for (const e of effects) {
		const row = byId.get(Number(e.policy_id));
		if (!row || !isWriteAction(e.action)) continue;
		const legal =
			isEntityMutationMode(e.effect) &&
			isLegalActionEffect(
				normalizeResourceClass(row.resource_class),
				e.action,
				e.effect,
			);
		// Pin an unknown/illegal stored effect to `deny` (fail closed), never drop.
		row.effects[e.action] =
			legal && isEntityMutationMode(e.effect) ? e.effect : "deny";
	}
	return rows;
}

function isWriteAction(value: unknown): value is WriteAction {
	return (
		value === "create" ||
		value === "update" ||
		value === "delete" ||
		value === "execute"
	);
}

async function loadCandidatePolicies(args: {
	organizationId: string;
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicyRow[]> {
	const sql = args.sql ?? getDb();
	const resourceClass = args.resourceClass ?? "entity";
	const principalKind = args.principalKind ?? null;
	const principalId = args.principalId ?? null;
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM write_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND resource_class = ${resourceClass}
      AND (
        principal_kind IS NULL
        OR (
          principal_kind = ${principalKind}
          AND (principal_id IS NULL OR principal_id = ${principalId})
        )
      )
      AND (entity_type_slug IS NULL OR entity_type_slug = ${args.entityTypeSlug ?? null})
      AND (entity_id IS NULL OR entity_id = ${args.entityId ?? null})
  `;
	const list = [...rows];
	await attachEffects(sql, list);
	return list.sort(compareCandidates);
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
				row.principal_kind === null &&
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
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
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
	/** Stable acting-principal id for per-principal matching; null = any of its kind. */
	principalId?: string | null;
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
	const policy = await resolveEntityApprovalPolicy({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
	});
	return modeToDecision(modeForAction(policy, args.action));
}


/**
 * Class-generic write decision for a non-scoped resource (agent_config today;
 * connector_action later). Humans with any org membership apply immediately —
 * the write-gate governs non-human principals; role restrictions for humans live
 * in the tool-access tier. For an agent/watcher, the matched policy row wins;
 * with no row, the class default applies. Entity writes keep their own scoped
 * paths ({@link evaluateEntityMutation} / {@link evaluateEntityFieldUpdates}).
 */
export async function resolveWritePolicyDecision(args: {
	organizationId: string;
	resourceClass: Exclude<WriteResourceClass, "entity">;
	principalKind: EntityPolicyPrincipalKind;
	principalId?: string | null;
	action: WriteAction;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	if (args.principalKind === "user") return "allow";
	const candidates = await loadCandidatePolicies({
		organizationId: args.organizationId,
		resourceClass: args.resourceClass,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		sql: args.sql,
	});
	const match = candidates[0];
	const mode = match
		? modeForAction(rowToPolicy(match), args.action)
		: defaultEffectFor(args.resourceClass, args.action);
	return modeToDecision(mode);
}

/**
 * Per-field decisions for a non-human update, from ONE policy query. A field
 * needs approval when the matched policy says so, or — regardless of policy —
 * when the field is human-owned.
 */
export async function evaluateEntityFieldUpdates(args: {
	organizationId: string;
	principalKind: EntityPolicyPrincipalKind;
	/** Stable acting-principal id for per-principal matching; null = any of its kind. */
	principalId?: string | null;
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
	const candidates = await loadCandidatePolicies({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
	});
	for (const [field, owner] of Object.entries(args.fields)) {
		const policy = pickPolicy(candidates, args.organizationId, field);
		// A human-owned field always needs approval regardless of policy mode; a
		// deny/disabled policy stops even a human-owned change (deny is a hard floor).
		const policyDecision = modeToDecision(policy.updateMode);
		decisions[field] =
			policyDecision === "deny"
				? "deny"
				: owner === "human" || policyDecision === "require_approval"
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
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM write_approval_policies
    WHERE organization_id = ${organizationId}
      AND resource_class = 'entity'
      AND principal_kind IS NULL
      AND entity_type_slug IS NULL
      AND field_path IS NULL
      AND entity_id IS NULL
    LIMIT 1
  `;
	if (!rows[0]) return defaultEntityApprovalPolicy(organizationId);
	await attachEffects(sql, rows as EntityApprovalPolicyRow[]);
	return rowToPolicy(rows[0]);
}

/**
 * Every policy row for an org, most-general first. Filter by class to list one
 * class's rows (the entity settings page passes `entity`); omit to list all.
 */
export async function listEntityApprovalPolicies(
	organizationId: string,
	resourceClass?: WriteResourceClass,
): Promise<EntityApprovalPolicy[]> {
	const sql = getDb();
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    FROM write_approval_policies
    WHERE organization_id = ${organizationId}
      AND (${resourceClass ?? null}::text IS NULL OR resource_class = ${resourceClass ?? null})
    ORDER BY
      resource_class ASC,
      CASE WHEN principal_kind IS NULL THEN 0 ELSE 1 END,
      principal_kind ASC NULLS FIRST,
      principal_id ASC NULLS FIRST,
      CASE WHEN entity_type_slug IS NULL THEN 0 ELSE 1 END,
      entity_type_slug ASC NULLS FIRST,
      CASE WHEN entity_id IS NULL THEN 0 ELSE 1 END,
      entity_id ASC NULLS FIRST,
      CASE WHEN field_path IS NULL THEN 0 ELSE 1 END,
      field_path ASC NULLS FIRST,
      id ASC
  `;
	await attachEffects(sql, [...rows]);
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

/**
 * Turn a policy input into the COMPLETE action→effect set to persist for the
 * given class. Every save writes a class's full action vocabulary (a complete
 * bundle, not a sparse override) so the child rows are self-consistent. For the
 * entity-shaped classes the effects come from create/update/delete; for
 * connector_action the single `execute` effect is taken from `createMode` (the
 * field the API carries it in until the connector-action UI ships a dedicated
 * one). Effects are clamped to what the manifest declares legal for the class.
 */
function actionEffectSetForInput(
	resourceClass: WriteResourceClass,
	input: EntityApprovalPolicyInput,
): Array<{ action: WriteAction; effect: EntityMutationMode }> {
	const clamp = (action: WriteAction, effect: EntityMutationMode) =>
		isLegalActionEffect(resourceClass, action, effect)
			? effect
			: defaultEffectFor(resourceClass, action);
	if (resourceClass === "connector_action") {
		return [
			{
				action: "execute",
				effect: clamp("execute", normalizeMode(input.createMode, "auto")),
			},
		];
	}
	return [
		{ action: "create", effect: clamp("create", normalizeMode(input.createMode, "auto")) },
		{ action: "update", effect: clamp("update", normalizeMode(input.updateMode, "auto")) },
		{ action: "delete", effect: clamp("delete", normalizeMode(input.deleteMode, "approval")) },
	];
}

/** Replace a policy's child action-effect rows with the given complete set. */
async function writeActionEffects(
	tx: DbClient,
	policyId: number,
	set: Array<{ action: WriteAction; effect: EntityMutationMode }>,
): Promise<void> {
	await tx`DELETE FROM write_policy_action_effects WHERE policy_id = ${policyId}`;
	for (const { action, effect } of set) {
		await tx`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${policyId}, ${action}, ${effect})
    `;
	}
}

export async function upsertEntityApprovalPolicy(
	organizationId: string,
	input: EntityApprovalPolicyInput,
): Promise<EntityApprovalPolicy> {
	const resourceClass = normalizeResourceClass(input.resourceClass);
	const principalKind = normalizePrincipalKind(input.principalKind);
	// A principal id is only meaningful with a kind; ignore it otherwise.
	const principalId = principalKind ? input.principalId?.trim() || null : null;
	const entityTypeSlug = input.entityTypeSlug?.trim() || null;
	const fieldPath = input.fieldPath?.trim() || null;
	const entityId = input.entityId ?? null;
	const effectSet = actionEffectSetForInput(resourceClass, input);
	const approvalConnectionId = input.approvalConnectionId?.trim() || null;
	const approvalChannelId = input.approvalChannelId?.trim() || null;
	const approvalTeamId = input.approvalTeamId?.trim() || null;
	const approvalChannelName = input.approvalChannelName?.trim() || null;

	const sql = getDb();
	// Upsert the header row (scope/principal/delivery only — effects live in the
	// child table). The identity tuple the unique index keys on; reused by both
	// UPDATE arms so the "lost the insert race" recovery targets the same row.
	const applyUpdate = (tx: DbClient) => tx<EntityApprovalPolicyRow>`
      UPDATE write_approval_policies
      SET approval_connection_id = ${approvalConnectionId},
          approval_channel_id = ${approvalChannelId},
          approval_team_id = ${approvalTeamId},
          approval_channel_name = ${approvalChannelName},
          updated_at = now()
      WHERE organization_id = ${organizationId}
        AND resource_class = ${resourceClass}
        AND principal_kind IS NOT DISTINCT FROM ${principalKind}
        AND principal_id IS NOT DISTINCT FROM ${principalId}
        AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
        AND field_path IS NOT DISTINCT FROM ${fieldPath}
        AND entity_id IS NOT DISTINCT FROM ${entityId}
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;

	const row = await sql.begin(async (tx) => {
		let header = (await applyUpdate(tx))[0] ?? null;

		if (!header) {
			const inserted = await tx<EntityApprovalPolicyRow>`
      INSERT INTO write_approval_policies (
        organization_id, resource_class, principal_kind, principal_id,
        entity_type_slug, field_path, entity_id,
        approval_connection_id, approval_channel_id, approval_team_id,
        approval_channel_name, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${resourceClass}, ${principalKind}, ${principalId},
        ${entityTypeSlug}, ${fieldPath}, ${entityId},
        ${approvalConnectionId},
        ${approvalChannelId}, ${approvalTeamId}, ${approvalChannelName},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;
			header = inserted[0] ?? null;
			// Lost the insert race to a concurrent save — apply this request on top.
			if (!header) header = (await applyUpdate(tx))[0] ?? null;
		}

		if (!header) return null;
		await writeActionEffects(tx, Number(header.id), effectSet);
		header.effects = {};
		for (const { action, effect } of effectSet) header.effects[action] = effect;
		return header;
	});
	if (!row) throw new Error("Failed to save entity approval policy");
	return rowToPolicy(row);
}

export async function deleteEntityApprovalPolicy(args: {
	organizationId: string;
	resourceClass?: WriteResourceClass;
	principalKind?: PolicyPrincipalKind | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
}): Promise<boolean> {
	const resourceClass = normalizeResourceClass(args.resourceClass);
	const principalKind = normalizePrincipalKind(args.principalKind);
	const principalId = principalKind ? args.principalId?.trim() || null : null;
	const entityTypeSlug = args.entityTypeSlug?.trim() || null;
	const fieldPath = args.fieldPath?.trim() || null;
	const entityId = args.entityId ?? null;
	// Guard: never let a request delete the workspace default (entity class, any
	// principal, unscoped) — that row is the fallback and is edited, not removed.
	if (
		resourceClass === "entity" &&
		principalKind === null &&
		!entityTypeSlug &&
		!fieldPath &&
		entityId === null
	) {
		return false;
	}
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    DELETE FROM write_approval_policies
    WHERE organization_id = ${args.organizationId}
      AND resource_class = ${resourceClass}
      AND principal_kind IS NOT DISTINCT FROM ${principalKind}
      AND principal_id IS NOT DISTINCT FROM ${principalId}
      AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
      AND field_path IS NOT DISTINCT FROM ${fieldPath}
      AND entity_id IS NOT DISTINCT FROM ${entityId}
    RETURNING id
  `;
	return rows.length > 0;
}
