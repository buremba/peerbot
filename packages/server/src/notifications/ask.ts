/**
 * Agent-authored asks: a notification that carries a DECISION, not just text.
 *
 * An agent can already ask a human a question inside a chat thread. It could not
 * ask one in their inbox — `notify.send` accepted a `card` with buttons, but a
 * caller-authored `actionId` matches no prefix the interaction bridge dispatches
 * on, so the buttons were dead on every surface. The fix is to accept the
 * CONTRACT (what is being asked) instead of the PRESENTATION (a card), and let
 * each surface render it: the schema is the thing every renderer already knows
 * how to consume.
 *
 * Storage is deliberately the shape every existing approval already uses, so the
 * inbox, the activity feed, the interaction bridge, and the expiry sweeper all
 * work on an ask without knowing what an ask is:
 *
 *   pending `runs` row (run_type='internal', action_key='agent_ask')
 *     └─ interaction event  (interaction_type='approval', run_id → the run,
 *                            interaction_input_schema → the ask's fields)
 *         └─ notification event (notification_type='action_approval_needed',
 *                                resource_type='event', resource_id → the
 *                                interaction event) + notification_targets rows
 *
 * Modelled on `manage_agents.queueWriteForApproval`, which queues the same three
 * rows for a builder write. The difference is only what approval MEANS: a
 * builder gate applies a held mutation, an ask records a human's answer.
 */

import { getErrorMessage } from "@lobu/core";
import { createAjv, formatAjvError } from "@lobu/core/ajv";
import type { ValidateFunction } from "ajv";
import { getDb } from "../db/client";
import { currentMcpActivityEventMetadata } from "../lobu/stores/mcp-client-conversations";
import { resolveRunInitiator } from "../tools/initiator";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { insertEvent } from "../utils/insert-event";
import {
	DEFAULT_METADATA_LIMITS,
	exceedsValidationLimits,
} from "../utils/metadata-limits";

/**
 * `runs.action_key` for an agent-authored ask.
 *
 * Registered as its own `BuilderApprovalHandler` family in `manage_operations`,
 * so claim/approve/reject/expire flow through the ONE generic path rather than a
 * parallel lifecycle.
 */
export const AGENT_ASK_ACTION_KEY = "agent_ask";

/**
 * Marks asks created after full answer-schema validation became mandatory.
 * Older pending asks intentionally have no version and retain their original
 * required-field-only approval behavior so a deploy cannot strand them.
 */
export const AGENT_ASK_INPUT_SCHEMA_VALIDATION_VERSION = 1;

/** What the agent asked, held in `runs.action_input` for the reviewer. */
export interface AgentAskProposal {
	question: string;
	/** Reviewer context retained so future Behavior runs can interpret the answer. */
	context?: string;
	/** Absent on legacy pending asks created before strict answer validation. */
	input_schema_validation_version?: number;
	/**
	 * JSON Schema for the answer. An EMPTY schema is meaningful and common: it
	 * means "decide, no fields" — the binary yes/no that renders as inline
	 * Approve/Reject on every surface with zero per-surface work.
	 */
	input_schema: Record<string, unknown>;
}

export function isAgentAskProposal(value: unknown): value is AgentAskProposal {
	if (value === null || typeof value !== "object") return false;
	const proposal = value as Record<string, unknown>;
	return typeof proposal.question === "string";
}

/** One selectable answer for a {@link AskAffordance} of kind `choice`. */
export interface AskChoice {
	/** Value recorded as the answer. */
	value: string;
	/** Button label. */
	label: string;
}

/**
 * How a surface should let a human answer — derived from the schema, never
 * declared by the agent.
 *
 *  - `binary` — no fields. Approve / Reject.
 *  - `choice` — ONE enum field. A button per option, answering in one click.
 *  - `form`   — anything richer. Needs real inputs, so it cannot be settled
 *               from a row; the reviewer opens it.
 *
 * Keeping this a function of the schema is the whole point of taking a contract
 * instead of a card: the agent says WHAT it needs, and each surface picks the
 * best control it can render — inline buttons on the web feed, a select in the
 * review form, or a plain review link in chat — without the agent knowing which
 * surface it reached.
 */
export type AskAffordance =
	| { kind: "binary" }
	| { kind: "choice"; field: string; choices: AskChoice[] }
	| { kind: "form" };

function readEnumOptions(value: unknown): AskChoice[] | null {
	if (value === null || typeof value !== "object") return null;
	const candidate = (value as Record<string, unknown>).enum;
	if (!Array.isArray(candidate)) return null;
	if (candidate.length < 2) return null;
	const choices: AskChoice[] = [];
	for (const option of candidate) {
		// Inline choice values travel through the Activity contract as strings.
		// Stringifying a numeric/boolean enum changes the answer's JSON type, so the
		// complete schema validator would refuse every click. Route those schemas to
		// the form, which preserves the option's original scalar value.
		if (typeof option !== "string") return null;
		choices.push({ value: option, label: option });
	}
	return choices;
}

/**
 * Classify an ask's schema into the control a surface should render.
 *
 * Replaced an allowlist of two entity-change action keys, which meant every
 * other approval family rendered without controls however simple its decision
 * was. Reading the schema instead means a new family gets the right affordance
 * without being added to a list, and a form-shaped ask can never degrade into
 * buttons that would silently discard what the human typed.
 */
export function resolveAskAffordance(
	schema: Record<string, unknown> | null | undefined,
): AskAffordance {
	if (!schema) return { kind: "binary" };

	const properties =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, unknown>)
			: {};
	const names = Object.keys(properties);
	const required = Array.isArray(schema.required) ? schema.required : [];

	// No fields at all — a bare decision. `required` without `properties` is
	// malformed rather than empty, so treat it as a form and let the reviewer see
	// the real schema rather than guessing on their behalf.
	if (names.length === 0) {
		return required.length === 0 ? { kind: "binary" } : { kind: "form" };
	}

	if (names.length === 1) {
		const field = names[0] as string;
		// A lone OPTIONAL enum would leave no way to express "answered nothing",
		// so a one-click choice must be the field the ask actually requires.
		if (required.length === 1 && required[0] === field) {
			const choices = readEnumOptions(properties[field]);
			if (choices) return { kind: "choice", field, choices };
		}
	}

	return { kind: "form" };
}

/**
 * Which required properties the answer left unanswered, as a reviewer-facing
 * message — or null when the answer is complete.
 *
 * This helper only supplies the friendlier REQUIRED-field message; the approval
 * handler follows it with full JSON Schema validation. Empty string and empty
 * array count as unanswered — the web form drops empty inputs before submitting,
 * so an untouched form arrives as `{}` and would otherwise record a successful,
 * empty answer.
 */
export function findUnansweredRequired(
	schema: Record<string, unknown> | null | undefined,
	input: Record<string, unknown> | null,
): string | null {
	const required = Array.isArray(schema?.required) ? schema.required : [];
	if (required.length === 0) return null;

	const answered = input ?? {};
	const missing = required.filter((field): field is string => {
		if (typeof field !== "string") return false;
		const value = answered[field];
		if (value === undefined || value === null || value === "") return true;
		return Array.isArray(value) && value.length === 0;
	});
	if (missing.length === 0) return null;

	return `This question requires an answer for ${missing
		.map((field) => `\`${field}\``)
		.join(", ")}. Approve again with those fields in \`input\`.`;
}

/**
 * Question schemas are synchronously compiled on the gateway request path.
 * A human-facing form should never need metadata's 10k-node/256 KiB ceiling;
 * this tighter budget caps attacker-controlled AJV code generation while still
 * allowing forms far larger than a reviewer can reasonably answer.
 */
const ASK_INPUT_SCHEMA_LIMITS = {
	maxDepth: 16,
	maxNodes: 500,
	maxBytes: 32_768,
};

function compileAskInputSchema(schema: Record<string, unknown>):
	| {
			validate: ValidateFunction;
			accepts: (subschema: Record<string, unknown>, value: unknown) => boolean;
	  }
	| { error: string } {
	// Both the schema and the eventual answer are untrusted agent/user input.
	// Bound the schema before AJV walks it, and build a request-scoped AJV so an
	// unbounded stream of unique question schemas cannot grow a process-global
	// validator cache for the lifetime of a gateway replica.
	if (exceedsValidationLimits(schema, ASK_INPUT_SCHEMA_LIMITS)) {
		return { error: "input_schema exceeds the allowed size or nesting limits" };
	}
	const unsupportedKeyword = findUnsupportedAskKeyword(schema);
	if (unsupportedKeyword) {
		return {
			error: `input_schema keyword '${unsupportedKeyword}' is not supported for interactive questions`,
		};
	}
	try {
		const ajv = createAjv({
			allErrors: false,
			strict: false,
			coerceTypes: false,
		});
		return {
			validate: ajv.compile(schema),
			accepts: (subschema, value) => ajv.validate(subschema, value),
		};
	} catch (error) {
		return { error: `input_schema is invalid: ${getErrorMessage(error)}` };
	}
}

const SINGLE_SUBSCHEMA_KEYWORDS = [
	"additionalProperties",
	"contentSchema",
	"items",
] as const;
const ARRAY_SUBSCHEMA_KEYWORDS = ["anyOf", "oneOf"] as const;
const MAP_SUBSCHEMA_KEYWORDS = ["$defs", "definitions", "properties"] as const;

const UNSUPPORTED_ASK_KEYWORDS = new Set([
	"$anchor",
	"$async",
	"$dynamicAnchor",
	"$dynamicRef",
	"$id",
	"$recursiveAnchor",
	"$recursiveRef",
	"$ref",
	"additionalItems",
	"allOf",
	"contains",
	"dependencies",
	"dependentRequired",
	"dependentSchemas",
	"else",
	"format",
	"formatExclusiveMaximum",
	"formatExclusiveMinimum",
	"formatMaximum",
	"formatMinimum",
	"if",
	"maxProperties",
	"maxContains",
	"minContains",
	"minProperties",
	"multipleOf",
	"not",
	"pattern",
	"patternProperties",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

const NULLABLE_WRAPPER_ANNOTATIONS = new Set([
	"$comment",
	"anyOf",
	"default",
	"deprecated",
	"description",
	"example",
	"examples",
	"readOnly",
	"title",
	"writeOnly",
]);

/**
 * Keep interactive questions to the JSON Schema subset the current answer form
 * actually renders. This is both a safety boundary (`pattern` can execute a
 * catastrophically backtracking regexp and `$async` changes validation into a
 * Promise) and a liveness boundary: references, conditionals, dependencies,
 * negation, and hidden combinators can make every visible answer invalid.
 *
 * Traverse only JSON Schema subschema positions. A generic object walk would
 * incorrectly reject a perfectly valid field literally named `pattern` under
 * `properties`.
 */
function findUnsupportedAskKeyword(
	root: Record<string, unknown>,
): string | null {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (
			current === null ||
			typeof current !== "object" ||
			Array.isArray(current)
		) {
			continue;
		}
		const schema = current as Record<string, unknown>;
		for (const keyword of UNSUPPORTED_ASK_KEYWORDS) {
			if (Object.hasOwn(schema, keyword)) return keyword;
		}

		for (const keyword of SINGLE_SUBSCHEMA_KEYWORDS) {
			const child = schema[keyword];
			if (keyword === "items" && Array.isArray(child)) {
				stack.push(...child);
			} else if (child !== undefined) {
				stack.push(child);
			}
		}
		for (const keyword of ARRAY_SUBSCHEMA_KEYWORDS) {
			const children = schema[keyword];
			if (Array.isArray(children)) stack.push(...children);
		}
		for (const keyword of MAP_SUBSCHEMA_KEYWORDS) {
			const children = schema[keyword];
			if (
				children !== null &&
				typeof children === "object" &&
				!Array.isArray(children)
			) {
				stack.push(...Object.values(children));
			}
		}
	}
	return null;
}

type JsonValueKind =
	| "array"
	| "boolean"
	| "integer"
	| "null"
	| "number"
	| "object"
	| "string";

function valueKind(value: unknown): JsonValueKind | null {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
			return Number.isInteger(value) ? "integer" : "number";
		case "object":
			return "object";
		default:
			return null;
	}
}

function declaredTypeAllows(
	declaredType: unknown,
	kind: JsonValueKind,
): boolean {
	if (declaredType === undefined) return true;
	const types = Array.isArray(declaredType) ? declaredType : [declaredType];
	return (
		types.includes(kind) || (kind === "integer" && types.includes("number"))
	);
}

/** Whether the supported schema subset admits the type a control emits. */
function schemaMayAcceptKind(value: unknown, kind: JsonValueKind): boolean {
	if (value === true) return true;
	if (
		value === false ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return false;
	}
	const schema = value as Record<string, unknown>;
	if (!declaredTypeAllows(schema.type, kind)) return false;

	if (Object.hasOwn(schema, "const")) {
		const actual = valueKind(schema.const);
		return actual === kind || (kind === "number" && actual === "integer");
	}
	if (Array.isArray(schema.enum)) {
		return schema.enum.some((option) => {
			const actual = valueKind(option);
			return actual === kind || (kind === "number" && actual === "integer");
		});
	}
	if (Array.isArray(schema.anyOf)) {
		if (!schema.anyOf.some((branch) => schemaMayAcceptKind(branch, kind))) {
			return false;
		}
	}
	if (Array.isArray(schema.oneOf)) {
		// Multiple branches can overlap for the emitted type, and the form has no
		// discriminator. Only claim compatibility when one branch can accept it.
		if (
			schema.oneOf.filter((branch) => schemaMayAcceptKind(branch, kind))
				.length !== 1
		) {
			return false;
		}
	}
	return validateScalarBounds("value", schema, kind) === null;
}

function isFormOptionValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function isScalarFormOptionValue(
	value: unknown,
): value is string | number | boolean {
	return isFormOptionValue(value) && value !== "";
}

/**
 * Find the cheapest non-empty string the generic text control can emit.
 *
 * The supported schema subset can constrain strings only through types,
 * constants/enums, length bounds, and anyOf/oneOf. Its truth value therefore
 * changes only at a declared length boundary or for a declared literal. Probe
 * those finite candidates against the COMPLETE item schema so sibling
 * constraints are treated as intersections (rather than inspecting a union
 * branch in isolation). Length-only candidates are evaluated arithmetically,
 * so an attacker cannot make this check allocate a schema-sized string.
 */
function minimumFormStringBytes(
	value: unknown,
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean,
): number | null {
	if (
		value === false ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return value === true ? 1 : null;
	}
	const schema = value as Record<string, unknown>;
	const literalCandidates = new Set<string>();
	const lengths = new Set<number>([1]);
	const stack: unknown[] = [schema];
	while (stack.length > 0) {
		const current = stack.pop();
		if (
			current === null ||
			typeof current !== "object" ||
			Array.isArray(current)
		) {
			continue;
		}
		const subschema = current as Record<string, unknown>;
		if (typeof subschema.const === "string" && subschema.const.length > 0) {
			literalCandidates.add(subschema.const);
		}
		if (Array.isArray(subschema.enum)) {
			for (const option of subschema.enum) {
				if (typeof option === "string" && option.length > 0) {
					literalCandidates.add(option);
				}
			}
		}
		for (const keyword of ["minLength", "maxLength"] as const) {
			const boundary = subschema[keyword];
			if (
				typeof boundary === "number" &&
				Number.isSafeInteger(boundary) &&
				boundary >= 1
			) {
				lengths.add(boundary);
			}
		}
		if (
			typeof subschema.maxLength === "number" &&
			Number.isSafeInteger(subschema.maxLength) &&
			subschema.maxLength >= 0 &&
			subschema.maxLength < Number.MAX_SAFE_INTEGER
		) {
			lengths.add(subschema.maxLength + 1);
		}
		for (const keyword of ARRAY_SUBSCHEMA_KEYWORDS) {
			const branches = subschema[keyword];
			if (Array.isArray(branches)) stack.push(...branches);
		}
	}

	let minimum: number | null = null;
	for (const candidate of literalCandidates) {
		if (!accepts(schema, candidate)) continue;
		const bytes = Buffer.byteLength(candidate, "utf8");
		minimum = minimum === null ? bytes : Math.min(minimum, bytes);
	}
	for (const length of lengths) {
		if (!schemaAcceptsGenericStringLength(schema, length)) continue;
		minimum = minimum === null ? length : Math.min(minimum, length);
	}
	return minimum;
}

/** Evaluate a non-literal ASCII string without allocating it. */
function schemaAcceptsGenericStringLength(
	value: unknown,
	length: number,
): boolean {
	if (value === true) return true;
	if (
		value === false ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return false;
	}
	const schema = value as Record<string, unknown>;
	if (!declaredTypeAllows(schema.type, "string")) return false;
	// Literal contracts are tested separately with the real value and AJV.
	if (Object.hasOwn(schema, "const") || Array.isArray(schema.enum))
		return false;
	if (typeof schema.minLength === "number" && length < schema.minLength) {
		return false;
	}
	if (typeof schema.maxLength === "number" && length > schema.maxLength) {
		return false;
	}
	if (
		Array.isArray(schema.anyOf) &&
		!schema.anyOf.some((branch) =>
			schemaAcceptsGenericStringLength(branch, length),
		)
	) {
		return false;
	}
	if (
		Array.isArray(schema.oneOf) &&
		schema.oneOf.filter((branch) =>
			schemaAcceptsGenericStringLength(branch, length),
		).length !== 1
	) {
		return false;
	}
	return true;
}

function minimumArraySelections(schema: Record<string, unknown>): number {
	const declared = typeof schema.minItems === "number" ? schema.minItems : 0;
	// Empty arrays are intentionally dropped by DynamicConnectorForm for every
	// field. Any array property the form actually submits therefore contains at
	// least one selection, including when the property itself is optional.
	return Math.max(declared, 1);
}

function literalFormOptions(schema: Record<string, unknown>): unknown[] | null {
	if (Array.isArray(schema.enum)) return schema.enum;
	const union = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: null;
	if (!union || union.length === 0) return null;
	const options: unknown[] = [];
	for (const branch of union) {
		if (
			branch === null ||
			typeof branch !== "object" ||
			Array.isArray(branch) ||
			!Object.hasOwn(branch, "const")
		) {
			return null;
		}
		options.push((branch as Record<string, unknown>).const);
	}
	return options;
}

function unwrapNullableFormProperty(
	property: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(property.anyOf)) return property;
	const nonNull = property.anyOf.filter(
		(branch) =>
			branch === null ||
			typeof branch !== "object" ||
			Array.isArray(branch) ||
			(branch as Record<string, unknown>).type !== "null",
	);
	if (nonNull.length !== 1 || nonNull.length === property.anyOf.length) {
		return property;
	}
	const unwrapped = nonNull[0];
	return unwrapped !== null &&
		typeof unwrapped === "object" &&
		!Array.isArray(unwrapped)
		? (unwrapped as Record<string, unknown>)
		: property;
}

function validateArrayFormProperty(params: {
	field: string;
	acceptanceSchema: Record<string, unknown>;
	renderProperty: Record<string, unknown>;
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean;
}): string | null {
	const { field, acceptanceSchema, renderProperty, accepts } = params;
	if (!schemaMayAcceptKind(acceptanceSchema, "array")) {
		return `input_schema array property '${field}' cannot be produced by the answer form`;
	}
	if (Object.hasOwn(renderProperty, "const")) {
		return `input_schema array property '${field}' uses a constant the answer form does not support`;
	}
	if (
		Array.isArray(renderProperty.items) ||
		renderProperty.prefixItems !== undefined
	) {
		return `input_schema array property '${field}' uses tuple items the answer form does not support`;
	}
	const minimumSelections = minimumArraySelections(renderProperty);
	const maximumSelections =
		typeof renderProperty.maxItems === "number"
			? renderProperty.maxItems
			: Number.POSITIVE_INFINITY;
	if (minimumSelections > maximumSelections) {
		return `input_schema array property '${field}' cannot satisfy its item count in the answer form`;
	}

	const items = renderProperty.items;
	if (items === undefined || items === true) return null;
	if (
		items === false ||
		items === null ||
		typeof items !== "object" ||
		Array.isArray(items)
	) {
		return `input_schema array property '${field}' cannot be produced by the answer form`;
	}
	const itemSchema = items as Record<string, unknown>;

	let options: unknown[] | null = null;
	if (Array.isArray(itemSchema.enum)) {
		options = itemSchema.enum;
	} else {
		const union = Array.isArray(itemSchema.anyOf)
			? itemSchema.anyOf
			: Array.isArray(itemSchema.oneOf)
				? itemSchema.oneOf
				: null;
		if (union) {
			const literalValues = union.flatMap((branch) => {
				if (
					branch !== null &&
					typeof branch === "object" &&
					!Array.isArray(branch) &&
					Object.hasOwn(branch, "const")
				) {
					return [(branch as Record<string, unknown>).const];
				}
				return [];
			});
			if (literalValues.length > 0 && literalValues.length !== union.length) {
				return `input_schema array property '${field}' uses a union the answer form cannot render`;
			}
			if (literalValues.length > 0) options = literalValues;
		}
	}

	if (options) {
		const distinctOptions = new Set(
			options.map((option) => `${typeof option}:${String(option)}`),
		);
		if (
			distinctOptions.size < minimumSelections ||
			options.some(
				(option) => !isFormOptionValue(option) || !accepts(itemSchema, option),
			)
		) {
			return `input_schema array property '${field}' has choices the answer form cannot submit`;
		}
		return null;
	}
	if (Object.hasOwn(itemSchema, "const")) {
		const constant = itemSchema.const;
		if (
			typeof constant !== "string" ||
			constant.length === 0 ||
			!accepts(itemSchema, constant) ||
			(renderProperty.uniqueItems === true && minimumSelections > 1)
		) {
			return `input_schema array property '${field}' has a constant the answer form cannot submit`;
		}
		return null;
	}

	// The generic array input splits comma-separated text and therefore emits
	// strings only. Reject integer/boolean/object/array item schemas, including
	// those types inside the supported unions.
	if (minimumFormStringBytes(itemSchema, accepts) === null) {
		return `input_schema array property '${field}' cannot be produced by the answer form`;
	}
	return null;
}

function validateScalarBounds(
	field: string,
	schema: Record<string, unknown>,
	kind: JsonValueKind,
): string | null {
	if (kind === "string") {
		const minimum = typeof schema.minLength === "number" ? schema.minLength : 0;
		const maximum =
			typeof schema.maxLength === "number"
				? schema.maxLength
				: Number.POSITIVE_INFINITY;
		if (minimum > maximum) {
			return `input_schema property '${field}' has contradictory length bounds`;
		}
		return null;
	}
	if (kind !== "number" && kind !== "integer") return null;

	const lowerBounds: Array<{ value: number; exclusive: boolean }> = [];
	if (typeof schema.minimum === "number") {
		lowerBounds.push({ value: schema.minimum, exclusive: false });
	}
	if (typeof schema.exclusiveMinimum === "number") {
		lowerBounds.push({ value: schema.exclusiveMinimum, exclusive: true });
	}
	const upperBounds: Array<{ value: number; exclusive: boolean }> = [];
	if (typeof schema.maximum === "number") {
		upperBounds.push({ value: schema.maximum, exclusive: false });
	}
	if (typeof schema.exclusiveMaximum === "number") {
		upperBounds.push({ value: schema.exclusiveMaximum, exclusive: true });
	}
	const minimum = lowerBounds.sort(
		(a, b) => b.value - a.value || Number(b.exclusive) - Number(a.exclusive),
	)[0];
	const maximum = upperBounds.sort(
		(a, b) => a.value - b.value || Number(b.exclusive) - Number(a.exclusive),
	)[0];
	if (minimum && maximum) {
		if (
			minimum.value > maximum.value ||
			(minimum.value === maximum.value &&
				(minimum.exclusive || maximum.exclusive))
		) {
			return `input_schema property '${field}' has contradictory numeric bounds`;
		}
	}
	if (kind === "integer") {
		const first = minimum
			? minimum.exclusive
				? Math.floor(minimum.value) + 1
				: Math.ceil(minimum.value)
			: Number.NEGATIVE_INFINITY;
		const last = maximum
			? maximum.exclusive
				? Math.ceil(maximum.value) - 1
				: Math.floor(maximum.value)
			: Number.POSITIVE_INFINITY;
		if (first > last) {
			return `input_schema property '${field}' has no integer within its numeric bounds`;
		}
	}
	return null;
}

function validateFormProperty(params: {
	field: string;
	property: Record<string, unknown>;
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean;
}): string | null {
	const acceptanceSchema = params.property;
	let renderProperty = acceptanceSchema;

	// Match DynamicConnectorForm's TypeBox-style nullable wrapper handling.
	if (Array.isArray(renderProperty.anyOf)) {
		const nonNull = renderProperty.anyOf.filter(
			(branch) =>
				branch === null ||
				typeof branch !== "object" ||
				Array.isArray(branch) ||
				(branch as Record<string, unknown>).type !== "null",
		);
		if (
			nonNull.length === 1 &&
			nonNull.length !== renderProperty.anyOf.length
		) {
			const unsupportedSibling = Object.keys(renderProperty).find(
				(keyword) => !NULLABLE_WRAPPER_ANNOTATIONS.has(keyword),
			);
			if (unsupportedSibling) {
				return `input_schema property '${params.field}' nullable wrapper sibling '${unsupportedSibling}' is not supported by the answer form`;
			}
			renderProperty = unwrapNullableFormProperty(acceptanceSchema);
		}
	}

	// A top-level enum overrides the ordinary input and becomes a typed select.
	if (Array.isArray(renderProperty.enum)) {
		if (
			renderProperty.enum.length === 0 ||
			renderProperty.enum.some(
				(option) =>
					!isScalarFormOptionValue(option) ||
					!params.accepts(acceptanceSchema, option),
			)
		) {
			return `input_schema property '${params.field}' has choices the answer form cannot submit`;
		}
		return null;
	}
	if (Array.isArray(renderProperty.anyOf)) {
		const literalValues = renderProperty.anyOf.flatMap((branch) => {
			if (
				branch !== null &&
				typeof branch === "object" &&
				!Array.isArray(branch) &&
				Object.hasOwn(branch, "const")
			) {
				return [(branch as Record<string, unknown>).const];
			}
			return [];
		});
		if (literalValues.length > 0) {
			if (
				literalValues.length !== renderProperty.anyOf.length ||
				literalValues.some(
					(option) =>
						!isScalarFormOptionValue(option) ||
						!params.accepts(acceptanceSchema, option),
				)
			) {
				return `input_schema property '${params.field}' has choices the answer form cannot submit`;
			}
			return null;
		}
		return `input_schema property '${params.field}' uses a union the answer form cannot render`;
	}
	if (Array.isArray(renderProperty.oneOf)) {
		return `input_schema property '${params.field}' uses oneOf, which the answer form cannot render`;
	}

	if (renderProperty.type === "array") {
		return validateArrayFormProperty({
			...params,
			acceptanceSchema,
			renderProperty,
		});
	}
	if (renderProperty.type === "object") {
		return `input_schema property '${params.field}' must not contain a nested object`;
	}

	const emittedKind: JsonValueKind =
		renderProperty.type === "number"
			? "number"
			: renderProperty.type === "integer"
				? "integer"
				: renderProperty.type === "boolean"
					? "boolean"
					: "string";
	const boundsError = validateScalarBounds(
		params.field,
		renderProperty,
		emittedKind,
	);
	if (boundsError) return boundsError;
	if (
		emittedKind === "string"
			? minimumFormStringBytes(acceptanceSchema, params.accepts) === null
			: !schemaMayAcceptKind(acceptanceSchema, emittedKind)
	) {
		return `input_schema property '${params.field}' cannot be produced by the answer form`;
	}
	if (Object.hasOwn(acceptanceSchema, "const")) {
		const constant = acceptanceSchema.const;
		if (
			!isScalarFormOptionValue(constant) ||
			!params.accepts(acceptanceSchema, constant)
		) {
			return `input_schema property '${params.field}' has a constant the answer form cannot submit`;
		}
		return null;
	}
	return null;
}

interface MinimumFormAnswerCost {
	nodes: number;
	bytes: number;
}

function primitiveAnswerBytes(value: unknown): number {
	return Buffer.byteLength(String(value), "utf8");
}

/** Minimum value cost for one field after the form's nullable unwrapping. */
function minimumFormPropertyCost(
	field: string,
	property: Record<string, unknown>,
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean,
): MinimumFormAnswerCost {
	const renderProperty = unwrapNullableFormProperty(property);
	const fieldBytes = Buffer.byteLength(field, "utf8");
	if (renderProperty.type === "array") {
		const selections = minimumArraySelections(renderProperty);
		const items = renderProperty.items;
		let valuesBytes: number;
		if (items !== null && typeof items === "object" && !Array.isArray(items)) {
			const itemSchema = items as Record<string, unknown>;
			const options = literalFormOptions(itemSchema);
			if (options) {
				// A multi-select emits each typed option at most once. Validation has
				// already proved that enough distinct options exist.
				const distinct = new Map<string, number>();
				for (const option of options) {
					const key = `${typeof option}:${String(option)}`;
					distinct.set(key, primitiveAnswerBytes(option));
				}
				valuesBytes = [...distinct.values()]
					.sort((a, b) => a - b)
					.slice(0, selections)
					.reduce((sum, bytes) => sum + bytes, 0);
			} else if (Object.hasOwn(itemSchema, "const")) {
				valuesBytes = selections * primitiveAnswerBytes(itemSchema.const);
			} else {
				const itemLength = minimumFormStringBytes(itemSchema, accepts) ?? 1;
				valuesBytes = selections * itemLength;
			}
		} else {
			// The generic array control emits non-empty strings.
			valuesBytes = selections;
		}
		return {
			nodes: 1 + selections,
			bytes: fieldBytes + valuesBytes,
		};
	}

	const options = literalFormOptions(renderProperty);
	let valueBytes: number;
	if (options) {
		valueBytes = Math.min(...options.map(primitiveAnswerBytes));
	} else if (Object.hasOwn(renderProperty, "const")) {
		valueBytes = primitiveAnswerBytes(renderProperty.const);
	} else if (renderProperty.type === "boolean") {
		valueBytes = primitiveAnswerBytes(true);
	} else if (
		renderProperty.type === "number" ||
		renderProperty.type === "integer"
	) {
		valueBytes = 1;
	} else {
		// Empty strings are dropped by the form, so even an optional submitted
		// text field consumes at least one UTF-8 byte.
		valueBytes = Math.max(
			typeof renderProperty.minLength === "number"
				? renderProperty.minLength
				: 0,
			1,
		);
	}
	return { nodes: 1, bytes: fieldBytes + valueBytes };
}

/**
 * Prove one minimally populated form answer fits the validator's own budget.
 * Root cardinality constraints are rejected because the renderer does not
 * expose field-presence semantics consistently; required fields are therefore
 * the complete minimum answer.
 */
function minimumFormAnswerExceedsLimits(params: {
	properties: Record<string, unknown>;
	required: string[];
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean;
}): boolean {
	const selected = params.required.map((field) =>
		minimumFormPropertyCost(
			field,
			params.properties[field] as Record<string, unknown>,
			params.accepts,
		),
	);
	const total = selected.reduce<MinimumFormAnswerCost>(
		(sum, cost) => ({
			nodes: sum.nodes + cost.nodes,
			bytes: sum.bytes + cost.bytes,
		}),
		{ nodes: 0, bytes: 0 },
	);
	return (
		total.nodes > DEFAULT_METADATA_LIMITS.maxNodes ||
		total.bytes > DEFAULT_METADATA_LIMITS.maxBytes
	);
}

/** Validate the contract before a pending run/event is durably created. */
function validateAskInputSchema(
	schema: Record<string, unknown>,
): string | null {
	const compiled = compileAskInputSchema(schema);
	if ("error" in compiled) return compiled.error;

	// `manage_operations.approve` accepts an object input, and the in-app form
	// renders top-level `properties`. A valid JSON Schema for a scalar root would
	// therefore queue a question no available approval path can answer.
	const declaredType = schema.type;
	const acceptsObject =
		declaredType === undefined ||
		declaredType === "object" ||
		(Array.isArray(declaredType) && declaredType.includes("object"));
	if (!acceptsObject) {
		return "input_schema must describe an object answer";
	}
	if (Object.hasOwn(schema, "const") || Array.isArray(schema.enum)) {
		return "input_schema root const and enum constraints are not supported by the answer form";
	}
	if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
		return "input_schema root unions are not supported by the answer form";
	}

	const properties =
		schema.properties !== null &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = Array.isArray(schema.required)
		? schema.required.filter(
				(field): field is string => typeof field === "string",
			)
		: [];
	const unrenderedRequired = required.filter(
		(field) => !Object.hasOwn(properties, field),
	);
	if (unrenderedRequired.length > 0) {
		return `input_schema requires fields missing from properties: ${unrenderedRequired.join(", ")}`;
	}

	for (const [field, propertySchema] of Object.entries(properties)) {
		if (Object.hasOwn(Object.prototype, field)) {
			return `input_schema property name '${field}' is not supported by the answer form`;
		}
		if (
			propertySchema === null ||
			typeof propertySchema !== "object" ||
			Array.isArray(propertySchema)
		) {
			return `input_schema property '${field}' must be a renderable schema`;
		}
		const propertyError = validateFormProperty({
			field,
			property: propertySchema as Record<string, unknown>,
			accepts: compiled.accepts,
		});
		if (propertyError) return propertyError;
	}
	if (
		minimumFormAnswerExceedsLimits({
			properties,
			required,
			accepts: compiled.accepts,
		})
	) {
		return "input_schema smallest form answer exceeds the allowed size limits";
	}

	const affordance = resolveAskAffordance(schema);
	if (affordance.kind === "choice") {
		for (const choice of affordance.choices) {
			if (!compiled.validate({ [affordance.field]: choice.value })) {
				return `input_schema choice '${choice.value}' does not satisfy the declared schema`;
			}
		}
	}

	// With no fields, every surface can only submit `{}` as an approval. Compile
	// success alone is insufficient: a valid-looking no-field schema can still
	// reject the only `{}` answer that a binary decision submits.
	if (affordance.kind === "binary" && !compiled.validate({})) {
		return "input_schema cannot be answered as a no-field decision";
	}

	return null;
}

/** Validate a human answer against the complete agent-authored JSON Schema. */
export function validateAskAnswer(
	schema: Record<string, unknown>,
	input: Record<string, unknown> | null,
): string | null {
	const answer = input ?? {};
	if (exceedsValidationLimits(answer)) {
		return "The answer exceeds the allowed size or nesting limits.";
	}
	const compiled = compileAskInputSchema(schema);
	if ("error" in compiled) return compiled.error;
	if (compiled.validate(answer)) return null;
	const firstError = compiled.validate.errors?.[0];
	return firstError
		? `Answer ${formatAjvError(firstError)}`
		: "Answer does not match input_schema";
}

/**
 * Queue an ask for a human: the pending run plus the interaction event that
 * carries its schema. The caller writes the notification that POINTS at the
 * returned `interactionEventId` — addressing is the notification's job, not the
 * interaction's.
 */
export async function queueAgentAsk(params: {
	ctx: ToolContext;
	question: string;
	body: string | null;
	inputSchema: Record<string, unknown>;
}): Promise<{ runId: number; interactionEventId: number }> {
	const schemaError = validateAskInputSchema(params.inputSchema);
	if (schemaError) throw new ToolUserError(schemaError, 422);

	const sql = getDb();
	const proposal: AgentAskProposal = {
		question: params.question,
		...(params.body ? { context: params.body } : {}),
		input_schema_validation_version: AGENT_ASK_INPUT_SCHEMA_VALIDATION_VERSION,
		input_schema: params.inputSchema,
	};
	const initiator = resolveRunInitiator(params.ctx);

	const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      watcher_id, window_id,
      created_by_user_id, initiator_kind, initiator_ref,
      approval_status, status, created_at
    ) VALUES (
      ${params.ctx.organizationId}, 'internal', ${AGENT_ASK_ACTION_KEY},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      ${params.ctx.actingWatcherId ?? null},
      ${params.ctx.actingWindowId ?? null},
      ${initiator.createdByUserId},
      ${initiator.initiatorKind},
      ${sql.json(initiator.initiatorRef)},
      'pending', 'pending', current_timestamp
    )
    RETURNING id
  `;
	const runId = Number((inserted[0] as { id: unknown }).id);

	const event = await insertEvent({
		entityIds: [],
		organizationId: params.ctx.organizationId,
		originId: `run_${runId}_pending`,
		title: params.question,
		content: params.body,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInputSchema: params.inputSchema,
		metadata: {
			tool: "notify",
			action_key: AGENT_ASK_ACTION_KEY,
			question: params.question,
			status: "pending_approval",
			run_id: runId,
			// WHO is asking. "Should I delete the staging data?" is a different
			// question from a Behavior than from an editor plugin someone just
			// installed, and the reviewer decides on the strength of that. Same
			// two stamps every sibling approval writes (`manage_agents`,
			// `manage_behaviors`, `entity-field-approval`): `initiator` resolves
			// the acting Behavior / agent session / user, and the MCP pair ties
			// the ask back to the client session that raised it.
			initiator: {
				kind: initiator.initiatorKind,
				...initiator.initiatorRef,
			},
			...currentMcpActivityEventMetadata(params.ctx),
		},
		authorName: params.ctx.clientId ?? "agent",
		// Deliberately NO connectionId: `authz/resource-visibility` exempts
		// interaction events from resource-membership checks on the premise that
		// connector sync never writes `interaction_type`. Stamping a connection on
		// an agent-minted interaction would let connection-scoped content ride that
		// exemption.
		clientId:
			params.ctx.tokenType === "oauth" ? (params.ctx.clientId ?? null) : null,
	});

	return { runId, interactionEventId: Number(event.id) };
}
