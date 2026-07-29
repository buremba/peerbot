import { isDeepStrictEqual } from "node:util";
import type {
	BehaviorEventTrigger,
	BehaviorScheduleTrigger,
	BehaviorTrigger,
} from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import { listCatalogEntries } from "../catalog/load";
import { validateSchedule, validateTimezone } from "../utils/cron";
import { ToolUserError } from "../utils/errors";

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
		SELECT name, behavior_events
		FROM connector_definitions
		WHERE organization_id = ${organizationId}
		  AND key = ${connectorKey}
		  AND status = 'active'
		ORDER BY updated_at DESC
		LIMIT 1
	`;
	const row = rows[0] as { name: string; behavior_events: unknown } | undefined;
	if (Array.isArray(row?.behavior_events)) {
		return {
			name: row.name,
			events: parseBehaviorEventDefinitions(row.behavior_events),
		};
	}

	// Existing bundled installations predate the persisted event-catalog
	// column. The immutable bundled catalog is a safe rolling-migration fallback;
	// new and custom installs persist their own metadata above.
	const catalog = (await listCatalogEntries(["connectors"])).connectors.find(
		(entry) => entry.id === connectorKey
	);
	return {
		name: row?.name ?? catalog?.name ?? connectorKey,
		events: parseBehaviorEventDefinitions(catalog?.detail.behavior_events),
	};
}

function normalizedEventTrigger(
	trigger: BehaviorEventTrigger
): BehaviorEventTrigger {
	const execution = trigger.execution ?? "turn";
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
 * instruction text. An omitted event execution defaults to "turn"
 * (the contract's default).
 */
export function behaviorRequiresInstructions(
	triggers: BehaviorTrigger[]
): boolean {
	if (triggers.length === 0) return true;
	return triggers.some(
		(trigger) =>
			trigger.kind === "schedule" ||
			(trigger.kind === "event" && trigger.execution === "window")
	);
}

/**
 * Enforce the instruction-presence rule on a Behavior write. UNGATED — unlike
 * `assertBehaviorTriggerConnections` (which create_version runs only when
 * triggers changed), this runs on every create and on every instruction write
 * (create_version with a prompt). Deliberately NOT on trigger updates:
 * `lobu apply` pushes triggers (`update`) then compiled instructions
 * (`create_version`) as two non-atomic calls, so a trigger-write assert would
 * reject the legitimate event-turn → schedule transition mid-apply; the CLI
 * preflights the full skills[] rule instead.
 */
export function assertBehaviorInstructions(
	triggers: BehaviorTrigger[],
	instructions: string | null | undefined
): void {
	if (!behaviorRequiresInstructions(triggers)) return;
	if (instructions?.trim()) return;
	throw new ToolUserError(
		"This Behavior runs from a schedule, an analysis window, or manual runs, so it needs instructions: attach at least one skill (their bodies compile into the stored instructions) or provide instruction text. Only event triggers with execution 'turn' may omit instructions."
	);
}

/** Validate connection-scoped triggers against the owning organization. */
export async function assertBehaviorTriggerConnections(
	sql: DbClient,
	organizationId: string,
	triggers: BehaviorTrigger[]
): Promise<void> {
	const eventTriggers = triggers.filter(
		(trigger): trigger is BehaviorEventTrigger => trigger.kind === "event"
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
		if (catalog.events.length === 0) {
			throw new ToolUserError(
				`${catalog.name} does not declare any Behavior events.`
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
}
