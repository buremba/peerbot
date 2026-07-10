/**
 * The write-action manifest — the single code-side source of truth for which
 * (resource class, action, effect) tuples are legal, and the per-(class, action)
 * default effect when no policy row matches.
 *
 * This replaces the positional create_mode/update_mode/delete_mode columns: a
 * policy is now `(scope, principal) → { action → effect }`, and each class
 * declares its own action vocabulary here rather than cramming every verb into
 * three fixed columns. `connector_action` has a single `execute` action instead
 * of being forced onto `create_mode`.
 *
 * A parallel DB CHECK mirrors this map (a TS object can't govern SQL or stored
 * rows on its own). When the two disagree — a stored row carrying an action or
 * effect this build no longer declares — the resolver fails CLOSED (deny), never
 * silently `auto`. See {@link isLegalActionEffect} and {@link defaultEffectFor}.
 */
import type { WriteResourceClass } from "./entity-policy";

/**
 * The verbs a write policy can govern. `create`/`update`/`delete` are the entity
 * and agent_config actions; `execute` is the connector_action verb (running a
 * connector operation). `install` is intentionally NOT declared until a class
 * actually uses it — an undeclared action is illegal, not a reserved no-op.
 */
export type WriteAction = "create" | "update" | "delete" | "execute";

/**
 * The decision a policy attaches to an action. `auto` applies inline; `approval`
 * queues a durable approval; `deny` is a hard floor (never applies, nothing
 * queued); `disabled` turns the action off entirely (connector_action only).
 */
export type WriteEffect = "auto" | "approval" | "deny" | "disabled";

interface ClassManifest {
	/** The actions this class governs. An action outside this set is illegal for the class. */
	readonly actions: readonly WriteAction[];
	/** The effects legal for this class. An effect outside this set is illegal for the class. */
	readonly effects: readonly WriteEffect[];
	/** The effect applied when no policy row matches, per action. */
	readonly defaultEffect: Readonly<Record<WriteAction, WriteEffect>>;
}

/**
 * Per-class legal actions/effects + no-row defaults. Defaults are stated
 * EXPLICITLY for every legal action (never an implicit `auto`) — an implicit
 * default would be a silent security downgrade for a class like agent_config
 * whose delete must default to deny.
 */
export const WRITE_ACTION_MANIFEST: Readonly<
	Record<WriteResourceClass, ClassManifest>
> = {
	entity: {
		actions: ["create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// Matches the historical entity default (create/update auto, delete approval).
		defaultEffect: {
			create: "auto",
			update: "auto",
			delete: "approval",
			execute: "deny",
		},
	},
	agent_config: {
		actions: ["create", "update", "delete"],
		effects: ["auto", "approval", "deny"],
		// An agent editing agent definitions is high-trust: create/update queue an
		// approval, delete is denied outright (a human must delete an agent).
		defaultEffect: {
			create: "approval",
			update: "approval",
			delete: "deny",
			execute: "deny",
		},
	},
	connector_action: {
		actions: ["execute"],
		effects: ["auto", "approval", "deny", "disabled"],
		// No org connector-action policy → auto, so the per-connection action_modes
		// alone decide (today's behavior). A row only ever tightens.
		defaultEffect: {
			execute: "auto",
			create: "deny",
			update: "deny",
			delete: "deny",
		},
	},
};

/** True when `(action, effect)` is a legal pair for this class. */
export function isLegalActionEffect(
	resourceClass: WriteResourceClass,
	action: WriteAction,
	effect: WriteEffect,
): boolean {
	const m = WRITE_ACTION_MANIFEST[resourceClass];
	return m.actions.includes(action) && m.effects.includes(effect);
}

/**
 * The no-row default effect for a (class, action). An action the class does not
 * govern falls back to `deny` — asking "what happens by default when a watcher
 * does X" for an X this class can't do is answered fail-closed.
 */
export function defaultEffectFor(
	resourceClass: WriteResourceClass,
	action: WriteAction,
): WriteEffect {
	const m = WRITE_ACTION_MANIFEST[resourceClass];
	if (!m.actions.includes(action)) return "deny";
	return m.defaultEffect[action];
}
