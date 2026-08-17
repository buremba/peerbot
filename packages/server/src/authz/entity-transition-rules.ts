/**
 * Declarative state-machine rules for entity rows — the VALIDATION half of
 * entity write policy, deliberately separate from the permission half.
 *
 * `runMutationGate` answers a PERMISSION question: may this principal write
 * this field. Its request is keyed on `principalKind`, ownership, and approval
 * state. This module answers a VALIDATION question: is the resulting state
 * legal. That question has no principal in it — a posted invoice is immutable
 * whether an agent, an automation, or a human proposed the write — which is
 * exactly why these rules must not live in a principal-keyed pipeline.
 *
 * Pure: no database, no clock, no principal. Entity types opt in by storing
 * `x-transitions` on `entity_types.metadata_schema`; a type declaring nothing
 * is untouched. "Frozen" means no VALUE change, so an idempotent rewrite of an
 * existing value is allowed.
 */

import { isDeepStrictEqual } from "node:util";

/** One declared state and the moves that may leave it. */
interface TransitionState {
	/** States this one may move to. Empty ⇒ terminal. */
	to: string[];
	/** When true, only the state field and `writableOnExit` fields may change. */
	frozen: boolean;
	/** Target state -> fields that may change alongside that transition. */
	writableOnExit: Record<string, string[]>;
}

export interface TransitionSpec {
	field: string;
	states: Record<string, TransitionState>;
}

/** Raised for a spec that is present but unusable; the caller fails closed. */
export class MalformedSpecError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseStringArray(value: unknown, where: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new MalformedSpecError(`${where} must be an array of strings`);
	}
	return value as string[];
}

/**
 * Parse a tenant-authored spec. Throws rather than returning null: a type that
 * declares `x-transitions` has opted in, so a typo must fail loudly instead of
 * silently disabling the invariant it asked for.
 *
 * State names are tenant data used as object keys, so every map here is a
 * null-prototype object and every membership test uses `Object.hasOwn` — a
 * state named `constructor` must not resolve through the prototype chain.
 */
export function parseTransitionSpec(raw: unknown): TransitionSpec {
	const spec = asRecord(raw);
	if (!spec) throw new MalformedSpecError("x-transitions must be an object");

	const field = spec.field;
	if (typeof field !== "string" || field.length === 0) {
		throw new MalformedSpecError(
			"x-transitions.field must be a non-empty string",
		);
	}

	const statesRaw = asRecord(spec.states);
	if (!statesRaw || Object.keys(statesRaw).length === 0) {
		throw new MalformedSpecError(
			"x-transitions.states must be a non-empty object",
		);
	}

	const states = Object.create(null) as Record<string, TransitionState>;
	for (const [name, value] of Object.entries(statesRaw)) {
		const state = asRecord(value);
		if (!state) {
			throw new MalformedSpecError(
				`x-transitions.states.${name} must be an object`,
			);
		}
		const frozen = state.frozen;
		if (frozen !== undefined && typeof frozen !== "boolean") {
			throw new MalformedSpecError(
				`x-transitions.states.${name}.frozen must be a boolean`,
			);
		}
		const writableOnExitRaw = asRecord(
			state.writableOnExit === undefined ? {} : state.writableOnExit,
		);
		if (!writableOnExitRaw) {
			throw new MalformedSpecError(
				`x-transitions.states.${name}.writableOnExit must be an object`,
			);
		}
		const writableOnExit = Object.create(null) as Record<string, string[]>;
		for (const [target, fields] of Object.entries(writableOnExitRaw)) {
			writableOnExit[target] = parseStringArray(
				fields,
				`x-transitions.states.${name}.writableOnExit.${target}`,
			);
		}
		states[name] = {
			to: parseStringArray(state.to, `x-transitions.states.${name}.to`),
			frozen: frozen === true,
			writableOnExit,
		};
	}

	// A `to` naming a state that does not exist can never be satisfied, so it is
	// a typo rather than a rule. Catch it at parse time, not at the write.
	for (const [name, state] of Object.entries(states)) {
		for (const target of state.to) {
			if (!Object.hasOwn(states, target)) {
				throw new MalformedSpecError(
					`x-transitions.states.${name}.to names unknown state "${target}"`,
				);
			}
		}
		for (const target of Object.keys(state.writableOnExit)) {
			if (!state.to.includes(target)) {
				throw new MalformedSpecError(
					`x-transitions.states.${name}.writableOnExit names non-transition target "${target}"`,
				);
			}
		}
	}
	return { field, states };
}

/**
 * Decide one write against a parsed spec.
 *
 * `committed` is the row as it stands; `patch` is the EFFECTIVE change about to
 * be written — not a proposal. Validating the patch rather than a proposal is
 * load-bearing: the permission pass strips approval-held fields and the
 * ownership merge rewrites others, so a rule fed the proposal can accept a
 * combination that never reaches the table (a header/line total pair whose
 * header is held for approval, leaving the line to commit against a stale
 * header). Only the patch is what actually lands.
 *
 * Returns a violation reason, or null for "legal".
 */
export function evaluateTransition(args: {
	spec: TransitionSpec;
	committed: Record<string, unknown>;
	patch: Record<string, unknown>;
}): string | null {
	const { spec, committed, patch } = args;
	const fromRaw = committed[spec.field];
	if (typeof fromRaw !== "string") return null;
	const from = Object.hasOwn(spec.states, fromRaw)
		? spec.states[fromRaw]
		: undefined;
	// An undeclared current state gets no opinion: a spec can only describe the
	// states it names, and failing closed here would freeze every row whose value
	// predates the rule. An undeclared TARGET is still denied below, because it
	// can never appear in a declared `to` list.
	if (!from) return null;

	let movingTo: string | null = null;
	if (Object.hasOwn(patch, spec.field)) {
		const next = patch[spec.field];
		if (typeof next !== "string") {
			return `state field "${spec.field}" must be a string`;
		}
		if (next !== fromRaw) movingTo = next;
	}

	if (movingTo !== null && !from.to.includes(movingTo)) {
		return `illegal transition ${fromRaw} -> ${movingTo}`;
	}

	if (from.frozen) {
		const exempt = new Set<string>([spec.field]);
		if (movingTo !== null) {
			for (const f of from.writableOnExit[movingTo] ?? []) exempt.add(f);
		}
		const illegal = Object.keys(patch).filter(
			(f) =>
				!exempt.has(f) &&
				!isDeepStrictEqual(committed[f] ?? null, patch[f] ?? null),
		);
		if (illegal.length > 0) {
			return `frozen in state "${fromRaw}": cannot write ${illegal.sort().join(", ")}`;
		}
	}
	return null;
}

/** Read a spec off a type's `metadata_schema`. Null ⇒ the type declares none. */
export function specFromMetadataSchema(
	rawSchema: unknown,
): TransitionSpec | null {
	const schema = asRecord(
		typeof rawSchema === "string" ? JSON.parse(rawSchema) : rawSchema,
	);
	const raw = schema?.["x-transitions"];
	if (raw === undefined) return null;
	return parseTransitionSpec(raw);
}
