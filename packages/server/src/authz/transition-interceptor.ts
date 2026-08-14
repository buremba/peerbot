import logger from "../utils/logger";
import type {
	EntityMutationRequest,
	MutationInterceptor,
	UpdateDecision,
} from "./entity-mutation-gate";

type TransitionSpec = {
	field: string;
	allowed: Record<string, string[]>;
	frozenFrom: string;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function parseTransitionSpec(schema: Record<string, unknown>): TransitionSpec | null {
	const raw = schema["x-transitions"];
	if (raw == null) return null;
	if (!raw || typeof raw !== "object") {
		throw new Error("x-transitions must be an object");
	}
	const field = (raw as { field?: unknown }).field;
	const allowed = (raw as { allowed?: unknown }).allowed;
	const frozenFrom = (raw as { frozen_from?: unknown }).frozen_from;
	if (typeof field !== "string" || field.length === 0) {
		throw new Error("x-transitions.field must be a non-empty string");
	}
	if (typeof frozenFrom !== "string" || frozenFrom.length === 0) {
		throw new Error("x-transitions.frozen_from must be a non-empty string");
	}
	if (!allowed || typeof allowed !== "object" || Array.isArray(allowed)) {
		throw new Error("x-transitions.allowed must be an object of string arrays");
	}
	const normalizedAllowed: Record<string, string[]> = {};
	for (const [state, next] of Object.entries(allowed as Record<string, unknown>)) {
		if (!Array.isArray(next) || next.some((value) => typeof value !== "string")) {
			throw new Error(`x-transitions.allowed.${state} must be a string array`);
		}
		normalizedAllowed[state] = next;
	}
	return { field, allowed: normalizedAllowed, frozenFrom };
}

function reachableStates(allowed: Record<string, string[]>, from: string): Set<string> {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const state = stack.pop();
		if (!state || seen.has(state)) continue;
		seen.add(state);
		for (const next of allowed[state] ?? []) stack.push(next);
	}
	return seen;
}

function valueChanged(current: unknown, proposed: unknown): boolean {
	return JSON.stringify(current ?? null) !== JSON.stringify(proposed ?? null);
}

function documentLabel(req: EntityMutationRequest, name: unknown): string {
	if (typeof name === "string" && name.length > 0) {
		return `${req.entityTypeSlug} \"${name}\"`;
	}
	return `${req.entityTypeSlug} ${req.action === "update" ? req.entityId : "document"}`;
}

async function evaluate(
	req: EntityMutationRequest,
): Promise<UpdateDecision | { outcome: "deny"; reason: string } | null> {
	if (req.action !== "update") return null;

	const rows = await req.sql<{
		name: string | null;
		metadata: unknown;
		metadata_schema: unknown;
	}>`
		SELECT e.name, e.metadata, et.metadata_schema
		FROM entities e
		JOIN entity_types et ON et.id = e.entity_type_id
		WHERE e.id = ${req.entityId}
		  AND e.organization_id = ${req.organizationId}
		  AND e.deleted_at IS NULL
		LIMIT 1
	`;
	if (rows.length === 0) {
		return {
			outcome: "deny",
			reason: `Entity ${req.entityId} no longer exists.`,
		};
	}

	const schema = parseJsonObject(rows[0].metadata_schema);
	let spec: TransitionSpec | null;
	try {
		spec = parseTransitionSpec(schema);
	} catch (error) {
		logger.error(
			{ err: error, entityId: req.entityId, entityTypeSlug: req.entityTypeSlug },
			"Malformed x-transitions schema; denying entity update",
		);
		return {
			outcome: "deny",
			reason: `Transition rules for ${req.entityTypeSlug} are malformed; refusing to update ${documentLabel(req, rows[0].name)}.`,
		};
	}
	if (!spec) return null;

	const currentMetadata = parseJsonObject(rows[0].metadata);
	const currentState = currentMetadata[spec.field];
	const proposedState = req.proposedValues[spec.field];
	const label = documentLabel(req, rows[0].name);
	const frozenStates = reachableStates(spec.allowed, spec.frozenFrom);
	if (typeof currentState === "string" && frozenStates.has(currentState)) {
		// The state field itself is exempt from the freeze: a frozen document may
		// still advance along a LEGAL transition, checked below. Without this, a
		// `frozen_from` at a non-terminal state strands the document one step
		// short of terminal forever — an invoice frozen at `issued` could never
		// reach `posted`. Every other field is immutable from here; a state move
		// that is not in `allowed[current]` is still denied by the transition
		// check, so a terminal state (empty `allowed`) remains fully sealed.
		const changed = Object.keys(req.fields).some(
			(field) =>
				field !== spec.field &&
				valueChanged(req.currentValues[field], req.proposedValues[field]),
		);
		if (changed) {
			return {
				outcome: "deny",
				reason: `${label} is frozen in state \"${currentState}\" and cannot be edited.`,
			};
		}
	}

	if (!Object.hasOwn(req.proposedValues, spec.field)) {
		return { outcome: "fields", requireApproval: new Set() };
	}
	if (!valueChanged(currentState, proposedState)) {
		return { outcome: "fields", requireApproval: new Set() };
	}
	if (typeof currentState !== "string" || typeof proposedState !== "string") {
		return {
			outcome: "deny",
			reason: `${label} has a non-string ${spec.field} value, so its transition cannot be validated.`,
		};
	}
	const allowedNext = spec.allowed[currentState];
	if (!allowedNext) {
		return {
			outcome: "deny",
			reason: `${label} is in unknown state \"${currentState}\" and cannot transition.`,
		};
	}
	if (!allowedNext.includes(proposedState)) {
		return {
			outcome: "deny",
			reason: `${label} cannot transition ${spec.field} from \"${currentState}\" to \"${proposedState}\".`,
		};
	}
	return { outcome: "fields", requireApproval: new Set() };
}

export const transitionInterceptor: MutationInterceptor = {
	name: "transition",
	evaluate,
};
