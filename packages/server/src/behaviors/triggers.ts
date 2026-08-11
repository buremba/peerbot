import { isDeepStrictEqual } from "node:util";
import {
	resolvedEventExecution,
	type BehaviorEventTrigger,
	type BehaviorScheduleTrigger,
	type BehaviorTrigger,
	type BehaviorWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import { listCatalogEntries } from "../catalog/load";
import { validateSchedule, validateTimezone } from "../utils/cron";
import { ToolUserError } from "../utils/errors";
import { withPlatformBehaviorEvents } from "./platform-event-catalog";

export interface BehaviorTriggerProjection {
	triggers: BehaviorTrigger[];
	schedule: string | null;
	timezone: string | null;
}

interface BehaviorEventDefinition {
	key: string;
	capabilities?: {
		steering?: boolean;
		replyToSource?: boolean;
	};
}

interface ConnectorBehaviorEventCatalog {
	name: string;
	events: BehaviorEventDefinition[];
	/** Events the CONNECTOR itself declares, before platform events are merged
	 * in. `events` always has at least `feed.auto_paused`, so it can never be
	 * empty and cannot answer "can this connector drive a trigger at all". */
	declaredCount: number;
	/** Feeds the connector declares. `feed.auto_paused` only ever fires for a
	 * connector that HAS a feed to pause, so zero declared events plus zero
	 * feeds means no event can reach this Behavior. */
	feedCount: number;
}

/** `feeds_schema` is an object keyed by feed key (`{}` for connectors that
 * declare none — non-null but empty, so a null check alone under-counts). */
function countDeclaredFeeds(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	return Object.keys(value).length;
}

function parseBehaviorEventDefinitions(
	value: unknown
): BehaviorEventDefinition[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is BehaviorEventDefinition =>
			typeof item === "object" &&
			item !== null &&
			typeof (item as { key?: unknown }).key === "string"
	);
}

async function getConnectorBehaviorEventCatalog(
	sql: DbClient,
	organizationId: string,
	connectorKey: string
): Promise<ConnectorBehaviorEventCatalog> {
	const rows = await sql`
		SELECT name, behavior_events, feeds_schema
		FROM connector_definitions
		WHERE organization_id = ${organizationId}
		  AND key = ${connectorKey}
		  AND status = 'active'
		ORDER BY updated_at DESC
		LIMIT 1
	`;
	const row = rows[0] as
		| { name: string; behavior_events: unknown; feeds_schema: unknown }
		| undefined;
	if (Array.isArray(row?.behavior_events)) {
		const declared = parseBehaviorEventDefinitions(row.behavior_events);
		return {
			name: row.name,
			events: withPlatformBehaviorEvents(declared) as BehaviorEventDefinition[],
			declaredCount: declared.length,
			feedCount: countDeclaredFeeds(row.feeds_schema),
		};
	}

	// Existing bundled installations predate the persisted event-catalog
	// column. The immutable bundled catalog is a safe rolling-migration fallback;
	// new and custom installs persist their own metadata above.
	const catalog = (await listCatalogEntries(["connectors"])).connectors.find(
		(entry) => entry.id === connectorKey
	);
	const declaredFallback = parseBehaviorEventDefinitions(
		catalog?.detail.behavior_events,
	);
	return {
		name: row?.name ?? catalog?.name ?? connectorKey,
		events: withPlatformBehaviorEvents(
			declaredFallback,
		) as BehaviorEventDefinition[],
		declaredCount: declaredFallback.length,
		feedCount: countDeclaredFeeds(
			row?.feeds_schema ?? catalog?.detail.feeds_schema,
		),
	};
}

function normalizedEventTrigger(
	trigger: BehaviorEventTrigger
): BehaviorEventTrigger {
	const execution = resolvedEventExecution(trigger);
	const activeRun = trigger.active_run ?? "queue";
	const output = trigger.output ?? "silent";
	if (execution === "window" && activeRun === "steer") {
		throw new ToolUserError(
			"Window execution does not support steering; use queue or coalesce."
		);
	}
	if (execution === "window" && output === "reply_to_source") {
		throw new ToolUserError(
			"Window execution cannot reply to the source; use turn execution or silent output."
		);
	}
	if (activeRun === "steer" && output !== "reply_to_source") {
		throw new ToolUserError(
			"Steering requires a turn that replies to the source; use queue or coalesce for silent output."
		);
	}
	// Unchecked UI checkboxes serialize as false. For opt-in filters like
	// mention_only, false means "no filter" — not "invert the condition". Drop
	// those keys so stored match objects stay sparse and exact-equality matching
	// cannot invert semantics.
	let match = trigger.match;
	if (match && Object.keys(match).length > 0) {
		const cleaned: Record<string, string | number | boolean | null> = {};
		for (const [key, value] of Object.entries(match)) {
			if (key === "mention_only" && value === false) continue;
			cleaned[key] = value;
		}
		match = Object.keys(cleaned).length > 0 ? cleaned : undefined;
	} else {
		match = undefined;
	}
	return {
		...trigger,
		source: "connector",
		event_types: Array.from(new Set(trigger.event_types)),
		match,
		execution,
		active_run: activeRun,
		output,
		skip_if_unchanged: trigger.skip_if_unchanged ?? true,
	};
}

function normalizedScheduleTrigger(
	trigger: BehaviorScheduleTrigger
): BehaviorScheduleTrigger {
	const scheduleError = validateSchedule(trigger.cron);
	if (scheduleError) throw new ToolUserError(scheduleError);
	if (trigger.timezone) {
		const timezoneError = validateTimezone(trigger.timezone);
		if (timezoneError) throw new ToolUserError(timezoneError);
	}
	return {
		kind: "schedule",
		cron: trigger.cron.trim(),
		timezone: trigger.timezone ?? null,
		execution: "window",
		active_run: "coalesce",
		skip_if_unchanged: trigger.skip_if_unchanged ?? true,
	};
}

function normalizedWorkspaceEventTrigger(
	trigger: BehaviorWorkspaceEventTrigger
): BehaviorWorkspaceEventTrigger {
	return {
		...trigger,
		entity_type: trigger.entity_type?.trim() || undefined,
		event_types: Array.from(new Set(trigger.event_types)),
		match:
			trigger.match && Object.keys(trigger.match).length > 0
				? trigger.match
				: undefined,
		execution: resolvedEventExecution(trigger),
		active_run: trigger.active_run ?? "coalesce",
	};
}

export function normalizeBehaviorTriggers(
	triggers: BehaviorTrigger[]
): BehaviorTrigger[] {
	let scheduleCount = 0;
	return triggers.map((trigger) => {
		if (trigger.kind === "schedule") {
			scheduleCount++;
			if (scheduleCount > 1) {
				throw new ToolUserError(
					"A Behavior can have at most one schedule trigger."
				);
			}
			return normalizedScheduleTrigger(trigger);
		}
		if (trigger.kind === "event" && trigger.source === "workspace") {
			return normalizedWorkspaceEventTrigger(trigger);
		}
		return normalizedEventTrigger(trigger);
	});
}

/** Compare trigger contracts after applying their canonical defaults. */
export function behaviorTriggersEqual(
	left: BehaviorTrigger[],
	right: BehaviorTrigger[]
): boolean {
	return isDeepStrictEqual(
		normalizeBehaviorTriggers(left),
		normalizeBehaviorTriggers(right)
	);
}

/**
 * Resolve the canonical trigger array and its indexed schedule projection.
 * Triggers are the only writable activation contract; schedule/timezone columns
 * are derived projections used by the scheduler.
 */
export function resolveBehaviorTriggerWrite(args: {
	triggers?: BehaviorTrigger[];
	currentTriggers?: BehaviorTrigger[];
}): BehaviorTriggerProjection {
	const current = normalizeBehaviorTriggers(args.currentTriggers ?? []);
	const triggers =
		args.triggers !== undefined
			? normalizeBehaviorTriggers(args.triggers)
			: [...current];

	const scheduleTrigger = triggers.find(
		(trigger): trigger is BehaviorScheduleTrigger => trigger.kind === "schedule"
	);

	return {
		triggers,
		schedule: scheduleTrigger?.cron ?? null,
		timezone: scheduleTrigger?.timezone ?? null,
	};
}

/**
 * Whether this trigger set runs on stored instructions alone. An event trigger
 * executing as "turn" carries its own content — the incoming message/event is
 * the input, and the built-in default instruction applies when the Behavior
 * has none. Schedule triggers, event triggers with execution "window", and an
 * empty trigger set (manual runs) have no such content, so they need
 * instruction text.
 */
export function behaviorRequiresInstructions(
	triggers: BehaviorTrigger[]
): boolean {
	if (triggers.length === 0) return true;
	return triggers.some(
		(trigger) =>
			trigger.kind === "schedule" ||
			(trigger.kind === "event" && resolvedEventExecution(trigger) === "window")
	);
}

/**
 * Declared outputs are finalized by complete_window. A turn execution is a
 * conversational agent turn and never enters that pipeline, so accepting both
 * on one Behavior would silently ignore its output contract for some firings.
 */
export function assertBehaviorOutputsUseWindowExecution(
	triggers: BehaviorTrigger[],
	outputs: Record<string, unknown> | null | undefined
): void {
	if (!outputs || Object.keys(outputs).length === 0) return;
	const turnTrigger = triggers.find(
		(trigger) =>
			trigger.kind === "event" && resolvedEventExecution(trigger) === "turn"
	);
	if (!turnTrigger) return;
	throw new ToolUserError(
		"Declared outputs require window execution. Change every event trigger to execution 'window', or put turn triggers in a separate Behavior."
	);
}

/**
 * Enforce the instruction-presence rule on a complete trigger + instruction
 * pair before either side is stored. Callers must pass the *final* resolved
 * values (inherited prompt/skills when omitted, resolved triggers after
 * write-merge).
 *
 * Either source satisfies the requirement on its own. They are no longer the
 * same field: skills used to be concatenated into `prompt` at save time, so one
 * check covered both, but pinned skills now remain separate from the stored
 * prompt. Requiring both would be stricter than the behaviour this replaced —
 * a Behavior whose whole job is "run this skill" has nothing to put in a task
 * statement, and one that spells its task out inline needs no skill.
 */
export function assertBehaviorInstructions(
	triggers: BehaviorTrigger[],
	instructions: string | null | undefined,
	skills?: ReadonlyArray<{ name: string; content: string }> | null
): void {
	if (!behaviorRequiresInstructions(triggers)) return;
	if (instructions?.trim()) return;
	if (skills?.some((skill) => skill.content.trim())) return;
	throw new ToolUserError(
		"This Behavior runs from a schedule, an analysis window, or manual runs, so it needs instructions: attach at least one skill or provide instruction text. Only event triggers with execution 'turn' may omit both."
	);
}

/** Validate connection-scoped triggers against the owning organization. */
export async function assertBehaviorTriggerConnections(
	sql: DbClient,
	organizationId: string,
	triggers: BehaviorTrigger[]
): Promise<void> {
	const eventTriggers = triggers.filter(
		(trigger): trigger is BehaviorEventTrigger =>
			trigger.kind === "event" && trigger.source !== "workspace"
	);
	const catalogs = new Map<string, ConnectorBehaviorEventCatalog>();
	for (const trigger of eventTriggers) {
		if (trigger.connection_id) {
			const rows = await sql`
				SELECT connector_key
				FROM connections
				WHERE id = ${trigger.connection_id}
				  AND organization_id = ${organizationId}
				  AND deleted_at IS NULL
				LIMIT 1
			`;
			if (rows.length === 0) {
				throw new ToolUserError(
					`Connection ${trigger.connection_id} was not found in this organization.`
				);
			}
			if (String(rows[0]?.connector_key) !== trigger.connector_key) {
				throw new ToolUserError(
					`Connection ${trigger.connection_id} is not a ${trigger.connector_key} connection.`
				);
			}
		}

		let catalog = catalogs.get(trigger.connector_key);
		if (!catalog) {
			catalog = await getConnectorBehaviorEventCatalog(
				sql,
				organizationId,
				trigger.connector_key
			);
			catalogs.set(trigger.connector_key, catalog);
		}
		// `catalog.events` ALWAYS carries the merged platform events, so the old
		// `events.length === 0` test could never be true and this guard never
		// fired. Ask the question that actually matters: can any event reach this
		// Behavior? A connector with no declared events can still legitimately
		// trigger on `feed.auto_paused` — but only if it has a feed to pause.
		// Zero declared events AND zero feeds means nothing can ever fire.
		if (catalog.declaredCount === 0 && catalog.feedCount === 0) {
			throw new ToolUserError(
				`${catalog.name} cannot drive an event trigger: it declares no Behavior events and has no feeds, so no event could ever fire.`
			);
		}
		const eventsByKey = new Map(
			catalog.events.map((event) => [event.key, event])
		);
		for (const eventType of trigger.event_types) {
			const event = eventsByKey.get(eventType);
			if (!event) {
				throw new ToolUserError(
					`${catalog.name} does not support Behavior event '${eventType}'.`
				);
			}
			if (trigger.active_run === "steer" && !event.capabilities?.steering) {
				throw new ToolUserError(
					`${catalog.name} event '${eventType}' does not support steering.`
				);
			}
			if (
				trigger.output === "reply_to_source" &&
				!event.capabilities?.replyToSource
			) {
				throw new ToolUserError(
					`${catalog.name} event '${eventType}' does not support replying to the source.`
				);
			}
		}
	}

	const workspaceTriggers = triggers.filter(
		(trigger): trigger is BehaviorWorkspaceEventTrigger =>
			trigger.kind === "event" && trigger.source === "workspace"
	);
	const eventKindsByEntityType = new Map<
		string,
		{ name: string; eventKinds: Record<string, unknown> }
	>();
	for (const trigger of workspaceTriggers) {
		const entityTypeSlug = trigger.entity_type;
		const catalogKey = entityTypeSlug ?? "*";
		let catalog = eventKindsByEntityType.get(catalogKey);
		if (!catalog) {
			const rows = entityTypeSlug
				? await sql`
					SELECT slug, name, event_kinds
					FROM entity_types
					WHERE organization_id = ${organizationId}
					  AND slug IN (${entityTypeSlug}, '$member')
					  AND deleted_at IS NULL
				`
				: await sql`
					SELECT slug, name, event_kinds
					FROM entity_types
					WHERE organization_id = ${organizationId}
					  AND deleted_at IS NULL
				`;
			const requestedType = entityTypeSlug
				? rows.find((row) => row.slug === entityTypeSlug)
				: undefined;
			if (entityTypeSlug && !requestedType) {
				throw new ToolUserError(
					`Workspace event trigger entity type '${entityTypeSlug}' was not found in this organization.`
				);
			}
			const orderedRows = entityTypeSlug
				? [
						rows.find((row) => row.slug === '$member'),
						requestedType,
					].filter(Boolean)
				: rows;
			const eventKinds = Object.assign(
				{},
				...orderedRows.map((row) =>
					row.event_kinds && typeof row.event_kinds === "object"
						? row.event_kinds
						: {}
				)
			);
			catalog = {
				name: entityTypeSlug
					? String(requestedType?.name ?? entityTypeSlug)
					: "Workspace",
				eventKinds,
			};
			eventKindsByEntityType.set(catalogKey, catalog);
		}
		for (const eventType of trigger.event_types) {
			if (!(eventType in catalog.eventKinds)) {
				throw new ToolUserError(
					`${catalog.name} does not declare workspace event '${eventType}'.`
				);
			}
		}
	}
}
