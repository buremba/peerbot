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
	WRITE_ACTION_MANIFEST,
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

/**
 * How the principal is acting. `attended` — a human is driving (chat, tool call).
 * `autonomous` — a scheduled/watcher run with no human in the loop. A policy row
 * scoped to `autonomous` (principal_mode='autonomous') applies only to
 * autonomous runs; a row with NULL principal_mode applies to BOTH. Autonomous is
 * always evaluated as at-least-as-strict as attended (attended is its floor), so
 * a watcher can never out-permission the same agent acting live.
 */
export type PrincipalMode = "attended" | "autonomous";

/**
 * Worker-token `source` values that mark a run as AUTONOMOUS — a server-dispatched
 * turn with NO human in the loop. Any run whose `sourceContext.source` is one of
 * these evaluates its write-gate decisions in autonomous mode (so an agent's
 * autonomous-only tighter rules bind). Everything else — an interactive turn
 * (`direct-api`, a slack/telegram/web platform turn), a user session — is attended.
 *
 * This MUST stay in lockstep with `HEADLESS_SOURCES` in
 * gateway/platform/unified-thread-consumer.ts: every source that bypasses the
 * SSE-owner gate there is a no-human dispatch and so must be governed
 * autonomously here. Adding a source to one without the other is a bug — a new
 * headless dispatch would otherwise be evaluated as attended and skip an agent's
 * autonomous-only restrictions. Producers of these claims:
 *   - `watcher-run`      gateway/routes/public/agent.ts (session.intent=watcher_run)
 *   - `scheduled-job`    scheduled/jobs.ts (a scheduled agent wake)
 *   - `connector-repair` connectors/repair-agent.ts (auto-fixing a broken connector)
 *   - `internal`         gateway/services/agent-threads.ts (server-dispatched default)
 * An unknown source falls to attended (never LOOSER than autonomous, per the
 * resolver's floor), so the failure mode of a missed source is over-, not
 * under-, restriction for the interactive path — but under-restriction for the
 * headless path, which is why the two sets must not drift.
 */
const AUTONOMOUS_SOURCES: ReadonlySet<string> = new Set([
	"watcher-run", // a watcher-dispatched agent turn (agent.ts intent=watcher_run)
	"scheduled-job", // a scheduled agent wake (scheduled/jobs.ts)
	"connector-repair", // a repair agent auto-fixing a connector (repair-agent.ts)
	"internal", // server-dispatched default turn (agent-threads.ts)
]);

/** The acting mode implied by a run's `source` (see {@link AUTONOMOUS_SOURCES}). */
export function modeForSource(source: string | null | undefined): PrincipalMode {
	return source != null && AUTONOMOUS_SOURCES.has(source)
		? "autonomous"
		: "attended";
}

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
	/** 'autonomous' = watcher-only override; NULL = applies to both acting modes. */
	principalMode: PrincipalMode | null;
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
	/** 'autonomous' scopes this row to watcher runs only; null = both modes. */
	principalMode?: PrincipalMode | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	createMode?: EntityMutationMode;
	updateMode?: EntityMutationMode;
	deleteMode?: EntityMutationMode;
	/**
	 * A raw per-action effect map. When present it is the source of truth for the
	 * persisted child rows (clamped to what the manifest declares legal for the
	 * class), letting a caller express `deny`/`disabled`/`execute` that the
	 * create/update/delete triple can't. When absent, effects derive from the mode
	 * triple (the legacy entity-settings path). Only actions the class governs are
	 * written; an illegal (action, effect) is clamped to the class default.
	 */
	effects?: Partial<Record<WriteAction, EntityMutationMode>>;
	approvalConnectionId?: string | null;
	approvalChannelId?: string | null;
	approvalTeamId?: string | null;
	approvalChannelName?: string | null;
	/**
	 * When true, an UPDATE of an existing header PRESERVES its stored approval
	 * delivery target instead of overwriting it with the (omitted → null) delivery
	 * fields above. The effect-only permissions PUT sets this: it never carries
	 * delivery, so without preservation each save would silently erase a configured
	 * Slack connection/channel/team/name. The entity-settings path leaves it unset —
	 * it always sends the delivery it wants and MEANS to write it (including clears).
	 * On INSERT this flag is a no-op (a brand-new row has no prior target to keep).
	 */
	preserveDelivery?: boolean;
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
	/** 'autonomous' = watcher-only override; NULL = applies to both modes. */
	principal_mode: string | null;
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

/** Stored principal_mode → typed. Only 'autonomous' is a scoping value; anything
 * else (including NULL/'attended') means "applies to both modes". */
function normalizePrincipalMode(value: unknown): PrincipalMode | null {
	return value === "autonomous" ? "autonomous" : null;
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
		principalMode: normalizePrincipalMode(row.principal_mode),
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
		principalMode: null,
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

/** Inverse of {@link mutationPrincipalId} for a watcher: `watcher:<id>` → id, else null. */
export function watcherIdFromPrincipalId(
	principalId: string | null | undefined,
): number | null {
	if (!principalId?.startsWith("watcher:")) return null;
	const id = Number(principalId.slice("watcher:".length));
	return Number.isFinite(id) ? id : null;
}

/**
 * The agent that owns a watcher (`watchers.agent_id`, NOT NULL in schema). Every
 * watcher write is governed by its owning agent's envelope — a watcher is that
 * agent's autonomous mode — so the resolver folds the agent's rows in via
 * `ownerAgentId`. Shared by every watcher write surface (entity promotion, reaction
 * scripts, watcher CRUD) so the linkage is resolved ONE way.
 *
 * Returns `{ ownerAgentId, resolved }`. `resolved` is false when the watcher row is
 * GONE (hard-deleted mid-reaction, or a bad id) OR its owning AGENT no longer exists
 * (deleted out from under an in-flight watcher — there is no watcher→agent FK, so the
 * agent_id can dangle) — both are the same security-relevant state: the acting
 * watcher's agent envelope can't be folded, so proceeding as an unowned watcher would
 * let the reaction slip its owning agent's deny/approval rules and fall back to the
 * (looser) org default. Callers acting on a TRUSTED watcher must FAIL CLOSED on
 * `resolved === false` (see the gate resolvers).
 *
 * `organizationId` scopes both the watcher AND the owning-agent existence check so a
 * caller can't resolve against another org's rows.
 */
export async function resolveWatcherOwner(
	sql: DbClient,
	watcherId: number,
	organizationId: string,
): Promise<{ ownerAgentId: string | null; resolved: boolean }> {
	// INNER JOIN agents: the row resolves ONLY when the owning agent still exists in
	// this org. A dangling agent_id (agent deleted mid-flight) yields zero rows →
	// resolved:false → gates deny, closing the fail-open where a deleted agent's
	// watcher would fall back to the looser org default.
	const rows = await sql<{ agent_id: string }>`
    SELECT w.agent_id
    FROM watchers w
    JOIN agents a ON a.id = w.agent_id AND a.organization_id = ${organizationId}
    WHERE w.id = ${watcherId} AND w.organization_id = ${organizationId}
    LIMIT 1
  `;
	if (rows.length === 0) return { ownerAgentId: null, resolved: false };
	return { ownerAgentId: rows[0].agent_id, resolved: true };
}

/** The fully-resolved acting principal for one write, ready to hand to the gate. */
export interface ActingPrincipal {
	kind: EntityPolicyPrincipalKind;
	/** `watcher:<id>` / agent id / null ("any of this kind"). */
	id: string | null;
	/** The watcher's owning agent, folded max-restrictive; null unless a watcher. */
	ownerAgentId: string | null;
	/**
	 * False ONLY when this is a watcher whose owning-agent lookup FAILED (the watcher
	 * row is gone). The gate must FAIL CLOSED (deny) rather than run the write as an
	 * unowned watcher against the looser org default — otherwise a reaction whose
	 * watcher was hard-deleted mid-flight escapes its agent's envelope. True for every
	 * agent/user turn and every watcher whose owner resolved (incl. legitimately null).
	 */
	ownerResolved: boolean;
	/** attended vs autonomous. A watcher is always autonomous. */
	mode: PrincipalMode;
}

/**
 * Resolve WHO is performing a write, from the two channels an acting watcher can
 * arrive on, in ONE place — so no call site has to merge them. A watcher is
 * identified by `ctx.actingWatcherId` (the reaction session's own watcher, stamped
 * by the reaction executor) OR by an explicit `watcher_source.watcher_id` (a tag
 * the caller passed, e.g. a keyed-promotion). The trusted SESSION watcher wins:
 * a reaction script can't retag itself with a different (nonexistent or
 * less-restricted) watcher to dodge its owning agent's envelope. Any watcher
 * channel makes this a watcher — which is strictly MORE restrictive, since it
 * folds the owning agent's rows in on top (a watcher can only tighten, never
 * loosen, its agent), so there's no way to "spoof a watcher tag" to escape agent
 * policy.
 *
 * When a watcher acts, this looks up its owning agent (folded max-restrictive) and
 * pins the mode to autonomous. With no watcher channel, an agent/user turn takes
 * `sourceForMode` for its attended-vs-autonomous classification. This is THE seam
 * every write surface (manage_entity/agents/operations/watchers, promotion)
 * resolves identity through.
 */
/** A watcher acting principal: autonomous, folding its (already-resolved) owner. */
function watcherPrincipal(
	watcherId: number,
	owner: { ownerAgentId: string | null; resolved: boolean },
): ActingPrincipal {
	return {
		kind: "watcher",
		id: `watcher:${watcherId}`,
		ownerAgentId: owner.ownerAgentId,
		ownerResolved: owner.resolved,
		mode: "autonomous",
	};
}

export async function resolveActingPrincipal(
	sql: DbClient,
	args: {
		organizationId: string;
		userId?: string | null;
		agentId?: string | null;
		explicitWatcherId?: number | null;
		sessionWatcherId?: number | null;
		/** The run source, used for mode ONLY when the actor is an agent/user. */
		sourceForMode?: string | null;
	},
): Promise<ActingPrincipal> {
	// The trusted SESSION watcher (stamped by the reaction executor) always wins and
	// folds its owning agent. An EXPLICIT watcher_source is caller-controlled, so it
	// can't override an authenticated agent's identity: honor it only when there is
	// no agent (the system/keyed-promotion path) OR when it genuinely belongs to that
	// agent (an agent tagging its own watcher). Otherwise a restricted agent could
	// tag a foreign/nonexistent watcher to null out ownerAgentId and skip its own
	// deny/approval rows — so we fall through to the agent as the principal.
	if (args.sessionWatcherId != null) {
		return watcherPrincipal(
			args.sessionWatcherId,
			await resolveWatcherOwner(sql, args.sessionWatcherId, args.organizationId),
		);
	}
	if (args.explicitWatcherId != null) {
		const owner = await resolveWatcherOwner(
			sql,
			args.explicitWatcherId,
			args.organizationId,
		);
		if (!args.agentId || owner.ownerAgentId === args.agentId) {
			return watcherPrincipal(args.explicitWatcherId, owner);
		}
		// Caller-controlled tag that isn't this agent's own watcher — ignore it.
	}
	const kind = classifyMutationPrincipal({
		userId: args.userId,
		agentId: args.agentId,
	});
	// A bound agent whose row was deleted out from under a still-live session must
	// FAIL CLOSED. Its envelope rows are gone (the delete trigger cascades them), so
	// gating would find no agent-specific policy and fall back to the looser org
	// default — most dangerously connector_action → auto. Mark it unresolved so every
	// gate denies, exactly as for a watcher whose owner vanished. Users are never
	// existence-checked here (they aren't gated as a principal). null agentId (the
	// system/keyed path) has no row to check and stays resolved.
	const ownerResolved =
		kind === "agent" && args.agentId != null
			? await agentExistsInOrg(sql, args.agentId, args.organizationId)
			: true;
	return {
		kind,
		id: mutationPrincipalId({ agentId: args.agentId }),
		ownerAgentId: null,
		ownerResolved,
		mode: modeForSource(args.sourceForMode),
	};
}

/** True iff an agent row with this id exists in the org. Org-scoped so a caller
 * can't probe another tenant's agent namespace. */
export async function agentExistsInOrg(
	sql: DbClient,
	agentId: string,
	organizationId: string,
): Promise<boolean> {
	const rows = await sql<{ one: number }>`
    SELECT 1 AS one FROM agents
    WHERE id = ${agentId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
	return rows.length > 0;
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
 * The more-restrictive of two modes (deny/disabled > approval > auto).
 *
 * `deny` and `disabled` are equally restrictive (both stop the write), so a fold
 * that mixes them must pick one DETERMINISTICALLY — not by candidate order, which
 * would make the resolved effect depend on scope specificity and diverge from what
 * the UI (which folds the same rows without that ordering) shows. We break the tie
 * toward `deny`: it is the safer, more-visible outcome — `list_available` still
 * SURFACES the op and gates it, rather than silently hiding it as `disabled` does.
 * The UI mirrors this exact rule (see EFFECT_STRICTNESS + stricterEffect).
 */
function moreRestrictive(
	a: EntityMutationMode,
	b: EntityMutationMode,
): EntityMutationMode {
	const ra = modeRestrictiveness(a);
	const rb = modeRestrictiveness(b);
	if (ra !== rb) return ra > rb ? a : b;
	// Equal rank: only deny/disabled tie here; prefer deny deterministically.
	return a === "deny" || b === "deny" ? "deny" : a;
}

/**
 * The effective effect for one action, folded MAX-RESTRICTIVE across the matched
 * rows that ADDRESS this action — the org-floor rule generalized. Two rules,
 * both deliberate (see the write-gate v1.1 design):
 *
 *  1. The class default is a STARTING POINT, not a floor. If ANY row explicitly
 *     sets this action, the default drops out entirely — an admin who sets
 *     `agent_config update = auto` gets auto even though the default is approval.
 *     Only when NO row addresses the action does the class default apply.
 *  2. Among the rows that DO set the action, the MOST RESTRICTIVE wins,
 *     regardless of scope. A broad org `approval` is never loosened by a narrow
 *     agent `auto`; a per-type `auto` never opens a hole a per-agent `approval`
 *     meant to close. This is the OPPOSITE of SQL GRANT precedence (where a
 *     more-specific grant widens) — the floor must hold.
 *
 * A row "addresses" the action only when it stored an explicit effect for it
 * (`row.effects[action]` present). A sparse override that names other actions
 * does NOT pull this action toward its class default — it simply abstains.
 */
function foldEffectForAction(
	candidates: EntityApprovalPolicyRow[],
	resourceClass: WriteResourceClass,
	action: WriteAction,
): EntityMutationMode {
	let folded: EntityMutationMode | null = null;
	for (const row of candidates) {
		const stored = row.effects[action];
		if (stored === undefined) continue; // row abstains on this action
		folded = folded === null ? stored : moreRestrictive(folded, stored);
	}
	return folded ?? defaultEffectFor(resourceClass, action);
}

/** True when a candidate row applies to autonomous runs only (not attended). */
function isAutonomousOnlyRow(row: EntityApprovalPolicyRow): boolean {
	return row.principal_mode === "autonomous";
}

/**
 * The effective effect for one action AT a given acting mode, layering the
 * attended/autonomous relationship on top of the max-restrictive fold.
 *
 *  - `attended`: fold over rows that apply to attended runs (principal_mode
 *    NULL — "both modes"). Autonomous-only rows are ignored.
 *  - `autonomous`: the ATTENDED result is the floor (a watcher can never be more
 *    permissive than the same agent acting live), then tightened by any
 *    autonomous-only override. So autonomous ≥ attended always holds structurally
 *    — an autonomous-only row that tried to LOOSEN is a no-op because we fold
 *    max-restrictive against the attended floor.
 */
function foldEffectWithMode(
	candidates: EntityApprovalPolicyRow[],
	resourceClass: WriteResourceClass,
	action: WriteAction,
	mode: PrincipalMode,
): EntityMutationMode {
	const attendedRows = candidates.filter((r) => !isAutonomousOnlyRow(r));
	const attended = foldEffectForAction(attendedRows, resourceClass, action);
	if (mode === "attended") return attended;
	// Autonomous: attended is the floor; autonomous-only overrides can only tighten.
	// A sparse autonomous row that does NOT name this action ABSTAINS (same rule as
	// foldEffectForAction) — it must not pull the action toward its class default,
	// which would tighten an action the admin never touched autonomously.
	let effect = attended;
	for (const row of candidates.filter(isAutonomousOnlyRow)) {
		const stored = row.effects[action];
		if (stored === undefined) continue; // row abstains on this action
		effect = moreRestrictive(effect, stored);
	}
	return effect;
}

/**
 * Order candidate rows most-specific first — used ONLY to choose the delivery
 * target (which Slack channel an approval card lands in), NOT the decision. The
 * decision is a max-restrictive fold ({@link foldEffectForAction}); specificity
 * would let a narrow `auto` mask a broad `approval`, so it must not drive it.
 * TARGET SCOPE specificity first, then principal specificity, then id for
 * determinism.
 */
function compareCandidates(
	a: EntityApprovalPolicyRow,
	b: EntityApprovalPolicyRow,
): number {
	return (
		scopeSpecificity(b) - scopeSpecificity(a) ||
		principalSpecificity(b) - principalSpecificity(a) ||
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
	/**
	 * The OWNING AGENT of a watcher, when a watcher acts under its agent's
	 * envelope. The write is then governed by BOTH the watcher's own rows (the
	 * primary `principalKind='watcher'`) AND the agent's rows, folded max-
	 * restrictive — so a pre-existing watcher-specific `deny` can only tighten and
	 * the agent envelope can never loosen it away. Null = no owning agent (the
	 * only two-principal case in the model: `watchers.agent_id` is the sole
	 * principal-ownership edge, so there is never a third principal to fold).
	 */
	ownerAgentId?: string | null;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	sql?: DbClient;
}): Promise<EntityApprovalPolicyRow[]> {
	const sql = args.sql ?? getDb();
	const resourceClass = args.resourceClass ?? "entity";
	const principalKind = args.principalKind ?? null;
	const principalId = args.principalId ?? null;
	const ownerAgentId = args.ownerAgentId ?? null;
	const rows = await sql<EntityApprovalPolicyRow>`
    SELECT id, organization_id, resource_class, principal_kind, principal_id,
       principal_mode, entity_type_slug, field_path, entity_id,
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
        OR (
          ${ownerAgentId}::text IS NOT NULL
          AND principal_kind = 'agent'
          AND (principal_id IS NULL OR principal_id = ${ownerAgentId})
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
	/**
	 * The owning agent of a watcher — folds the agent's rows in alongside the
	 * watcher's, max-restrictive. See {@link loadCandidatePolicies}.
	 */
	ownerAgentId?: string | null;
	action: EntityMutationAction;
	entityTypeSlug?: string | null;
	entityId?: number | null;
	entityOrgId?: string | null;
	/**
	 * False iff the acting principal is a watcher whose owning agent could not be
	 * resolved (its row is gone). Fail CLOSED — the agent envelope can't be folded,
	 * so we deny rather than run the write against the looser org default. Defaults
	 * true (agent/user turns, and watchers whose owner resolved).
	 */
	ownerResolved?: boolean;
	/** Attended (human-driven) vs autonomous (watcher). Defaults attended. */
	mode?: PrincipalMode;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	if (args.entityOrgId && args.entityOrgId !== args.organizationId) {
		return "deny";
	}
	if (args.principalKind === "user") return "allow";
	if (args.ownerResolved === false) return "deny";
	const candidates = await loadCandidatePolicies({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
	});
	// create/delete act on the WHOLE entity, not any one field — a field-scoped
	// row (e.g. person.ssn=deny) governs only its field's UPDATES and must not
	// bleed into the entity's create/delete decision. Drop field-scoped rows here
	// (the update path keeps them, matched per-field). What remains — the org
	// floor, blanket, and type-scoped rows — folds max-restrictive, then layers
	// the attended/autonomous relationship.
	const forEntity = candidates.filter((row) => row.field_path === null);
	return modeToDecision(
		foldEffectWithMode(forEntity, "entity", args.action, args.mode ?? "attended"),
	);
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
	/**
	 * The owning agent of a watcher — folds the agent's rows in alongside the
	 * watcher's, max-restrictive. Set for a watcher-attributed connector/agent_config
	 * write (e.g. a reaction script's `client.operations.execute`) so the agent's
	 * envelope binds and a watcher-specific rule can only tighten. See
	 * {@link loadCandidatePolicies}.
	 */
	ownerAgentId?: string | null;
	/** See {@link resolveWriteEffect}. Fail closed (deny) when a watcher owner is unresolved. */
	ownerResolved?: boolean;
	action: WriteAction;
	/**
	 * Whether the principal is acting attended (a human is driving the agent) or
	 * autonomously (a watcher / scheduled run). Autonomous folds the attended
	 * decision as its floor, then tightens with any autonomous-only override — a
	 * watcher can never be more permissive than the same agent acting live.
	 */
	mode?: PrincipalMode;
	sql?: DbClient;
}): Promise<EntityPolicyDecision> {
	return modeToDecision(await resolveWriteEffect(args));
}

/**
 * The raw folded EFFECT (auto/approval/deny/disabled) for a non-scoped resource,
 * before it collapses to a decision. `disabled` and `deny` both stop the write,
 * but callers that must DISTINGUISH them — e.g. `list_available` hides a disabled
 * connector's operations rather than surfacing them to fail on execute — need the
 * effect, not the decision. A human always resolves `auto`.
 */
export async function resolveWriteEffect(args: {
	organizationId: string;
	resourceClass: Exclude<WriteResourceClass, "entity">;
	principalKind: EntityPolicyPrincipalKind;
	principalId?: string | null;
	ownerAgentId?: string | null;
	/**
	 * False iff a watcher whose owning agent could not be resolved (its row is
	 * gone) — fail CLOSED to `deny` so the write can't slip its agent's envelope.
	 * See {@link evaluateEntityMutation}. Defaults true.
	 */
	ownerResolved?: boolean;
	action: WriteAction;
	mode?: PrincipalMode;
	sql?: DbClient;
}): Promise<EntityMutationMode> {
	if (args.principalKind === "user") return "auto";
	if (args.ownerResolved === false) return "deny";
	const candidates = await loadCandidatePolicies({
		organizationId: args.organizationId,
		resourceClass: args.resourceClass,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
		sql: args.sql,
	});
	return foldEffectWithMode(
		candidates,
		args.resourceClass,
		args.action,
		args.mode ?? "attended",
	);
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
	/** The watcher's owning agent, folded alongside — see {@link evaluateEntityMutation}. */
	ownerAgentId?: string | null;
	/**
	 * False iff a watcher whose owning agent could not be resolved — deny every
	 * field (fail closed). See {@link evaluateEntityMutation}. Defaults true.
	 */
	ownerResolved?: boolean;
	entityTypeSlug: string;
	entityId: number;
	entityOrgId?: string | null;
	/** field path -> current owner ("human" pins the field). */
	fields: Record<string, "human" | "none">;
	/** Attended (human-driven) vs autonomous (watcher). Defaults attended. */
	mode?: PrincipalMode;
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
	if (args.ownerResolved === false) {
		for (const field of Object.keys(args.fields)) decisions[field] = "deny";
		return decisions;
	}
	const candidates = await loadCandidatePolicies({
		...args,
		principalKind: args.principalKind,
		principalId: args.principalId ?? null,
		ownerAgentId: args.ownerAgentId ?? null,
	});
	const mode = args.mode ?? "attended";
	for (const [field, owner] of Object.entries(args.fields)) {
		// Fold max-restrictive over every candidate that applies to THIS field
		// (its own field_path row, plus all field-agnostic rows). The org floor
		// holds and a field-scoped override can only tighten.
		const forField = candidates.filter(
			(row) => row.field_path === null || row.field_path === field,
		);
		const policyDecision = modeToDecision(
			foldEffectWithMode(forField, "entity", "update", mode),
		);
		// A human-owned field always needs approval regardless of policy mode; a
		// deny/disabled policy stops even a human-owned change (deny is a hard floor).
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
       principal_mode, entity_type_slug, field_path, entity_id,
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
       principal_mode, entity_type_slug, field_path, entity_id,
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
 * Turn a policy input into the action→effect set to persist for the given class.
 * For the entity-shaped classes the effects come from create/update/delete; for
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
	// Raw effects map wins when provided (the agent Permissions path). Persist ONLY
	// the actions the caller named — this is a SPARSE override, so an omitted action
	// must NOT get an explicit row that pins it to the class default. A stored row
	// stops the action from abstaining (see foldEffectForAction), which would freeze
	// it against later attended/blanket changes. Only actions THIS CLASS governs.
	if (input.effects) {
		const governed = new Set(WRITE_ACTION_MANIFEST[resourceClass].actions);
		return (Object.keys(input.effects) as WriteAction[])
			.filter((action) => governed.has(action) && input.effects?.[action] !== undefined)
			.map((action) => ({
				action,
				effect: clamp(action, input.effects?.[action] as EntityMutationMode),
			}));
	}
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
	// A mode scoping is only meaningful for a principal-targeted row.
	const principalMode = principalKind
		? normalizePrincipalMode(input.principalMode)
		: null;
	const entityTypeSlug = input.entityTypeSlug?.trim() || null;
	const fieldPath = input.fieldPath?.trim() || null;
	const entityId = input.entityId ?? null;
	const effectSet = actionEffectSetForInput(resourceClass, input);
	const approvalConnectionId = input.approvalConnectionId?.trim() || null;
	const approvalChannelId = input.approvalChannelId?.trim() || null;
	const approvalTeamId = input.approvalTeamId?.trim() || null;
	const approvalChannelName = input.approvalChannelName?.trim() || null;
	// Effect-only callers (the permissions PUT) don't carry a delivery target and
	// must not clobber the one already stored. When preserveDelivery is set, COALESCE
	// each column to its existing value so an omitted (null) field keeps the header's
	// current target; a caller that MEANS to write delivery leaves the flag unset.
	const preserveDelivery = input.preserveDelivery === true;

	const sql = getDb();
	// Upsert the header row (scope/principal/delivery only — effects live in the
	// child table). The identity tuple the unique index keys on; reused by both
	// UPDATE arms so the "lost the insert race" recovery targets the same row.
	const applyUpdate = (tx: DbClient) => tx<EntityApprovalPolicyRow>`
      UPDATE write_approval_policies
      SET approval_connection_id = ${
				preserveDelivery ? sql`COALESCE(approval_connection_id, ${approvalConnectionId})` : approvalConnectionId
			},
          approval_channel_id = ${
						preserveDelivery ? sql`COALESCE(approval_channel_id, ${approvalChannelId})` : approvalChannelId
					},
          approval_team_id = ${
						preserveDelivery ? sql`COALESCE(approval_team_id, ${approvalTeamId})` : approvalTeamId
					},
          approval_channel_name = ${
						preserveDelivery ? sql`COALESCE(approval_channel_name, ${approvalChannelName})` : approvalChannelName
					},
          updated_at = now()
      WHERE organization_id = ${organizationId}
        AND resource_class = ${resourceClass}
        AND principal_kind IS NOT DISTINCT FROM ${principalKind}
        AND principal_id IS NOT DISTINCT FROM ${principalId}
        AND principal_mode IS NOT DISTINCT FROM ${principalMode}
        AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
        AND field_path IS NOT DISTINCT FROM ${fieldPath}
        AND entity_id IS NOT DISTINCT FROM ${entityId}
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       principal_mode, entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id, approval_team_id,
       approval_channel_name
    `;

	const row = await sql.begin(async (tx) => {
		let header = (await applyUpdate(tx))[0] ?? null;

		if (!header) {
			const inserted = await tx<EntityApprovalPolicyRow>`
      INSERT INTO write_approval_policies (
        organization_id, resource_class, principal_kind, principal_id,
        principal_mode, entity_type_slug, field_path, entity_id,
        approval_connection_id, approval_channel_id, approval_team_id,
        approval_channel_name, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${resourceClass}, ${principalKind}, ${principalId},
        ${principalMode}, ${entityTypeSlug}, ${fieldPath}, ${entityId},
        ${approvalConnectionId},
        ${approvalChannelId}, ${approvalTeamId}, ${approvalChannelName},
        now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id, organization_id, resource_class, principal_kind, principal_id,
       principal_mode, entity_type_slug, field_path, entity_id,
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
	principalMode?: PrincipalMode | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
}): Promise<boolean> {
	const resourceClass = normalizeResourceClass(args.resourceClass);
	const principalKind = normalizePrincipalKind(args.principalKind);
	const principalId = principalKind ? args.principalId?.trim() || null : null;
	const principalMode = principalKind
		? normalizePrincipalMode(args.principalMode)
		: null;
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
      AND principal_mode IS NOT DISTINCT FROM ${principalMode}
      AND entity_type_slug IS NOT DISTINCT FROM ${entityTypeSlug}
      AND field_path IS NOT DISTINCT FROM ${fieldPath}
      AND entity_id IS NOT DISTINCT FROM ${entityId}
    RETURNING id
  `;
	return rows.length > 0;
}
