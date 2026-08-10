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
import { exceedsValidationLimits } from "../utils/metadata-limits";

/**
 * `runs.action_key` for an agent-authored ask.
 *
 * Registered as its own `BuilderApprovalHandler` family in `manage_operations`,
 * so claim/approve/reject/expire flow through the ONE generic path rather than a
 * parallel lifecycle.
 */
export const AGENT_ASK_ACTION_KEY = "agent_ask";

/** What the agent asked, held in `runs.action_input` for the reviewer. */
export interface AgentAskProposal {
	question: string;
	/** Reviewer context retained so future Behavior runs can interpret the answer. */
	context?: string;
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
	if (exceedsValidationLimits(schema)) {
		return { error: "input_schema exceeds the allowed size or nesting limits" };
	}
	const unsupportedKeyword = findUnsupportedExecutionKeyword(schema);
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
	"additionalItems",
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
] as const;
const ARRAY_SUBSCHEMA_KEYWORDS = [
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems",
] as const;
const MAP_SUBSCHEMA_KEYWORDS = [
	"$defs",
	"definitions",
	"dependentSchemas",
	"properties",
] as const;

/**
 * Find execution-affecting keywords before AJV compiles the schema. JavaScript
 * regexes can backtrack exponentially, so even a short human answer could stall
 * the shared gateway event loop. `$async` would instead turn validation into a
 * Promise while this synchronous approval path treats the Promise as success.
 *
 * Traverse only JSON Schema subschema positions. A generic object walk would
 * incorrectly reject a perfectly valid field literally named `pattern` under
 * `properties`.
 */
function findUnsupportedExecutionKeyword(
	root: Record<string, unknown>,
): "$async" | "pattern" | "patternProperties" | null {
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
		if (Object.hasOwn(schema, "$async")) return "$async";
		if (Object.hasOwn(schema, "pattern")) return "pattern";
		if (Object.hasOwn(schema, "patternProperties")) {
			return "patternProperties";
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

		// Draft-07 `dependencies` is either a string array or a subschema per
		// property. Only the latter is another JSON Schema location.
		const dependencies = schema.dependencies;
		if (
			dependencies !== null &&
			typeof dependencies === "object" &&
			!Array.isArray(dependencies)
		) {
			for (const dependency of Object.values(dependencies)) {
				if (!Array.isArray(dependency)) stack.push(dependency);
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

/**
 * Whether a schema has a possible value of the JSON type a form control emits.
 * This is intentionally conservative for constructs the renderer cannot
 * inspect (`$ref`, conditionals, and `not`): queuing no question is preferable
 * to queuing one every visible control is structurally unable to answer.
 */
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
	if (Object.hasOwn(schema, "$ref") || Object.hasOwn(schema, "not")) {
		return false;
	}
	if (
		Object.hasOwn(schema, "if") ||
		Object.hasOwn(schema, "then") ||
		Object.hasOwn(schema, "else")
	) {
		return false;
	}

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
	if (Array.isArray(schema.allOf)) {
		if (!schema.allOf.every((branch) => schemaMayAcceptKind(branch, kind))) {
			return false;
		}
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
	return true;
}

function isFormOptionValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function minimumArraySelections(
	schema: Record<string, unknown>,
	isRequired: boolean,
): number {
	const declared = typeof schema.minItems === "number" ? schema.minItems : 0;
	// Empty arrays are intentionally dropped by DynamicConnectorForm, so a
	// required array needs at least one actual selection even when minItems is 0.
	return Math.max(declared, isRequired ? 1 : 0);
}

function validateArrayFormProperty(params: {
	field: string;
	acceptanceSchema: Record<string, unknown>;
	renderProperty: Record<string, unknown>;
	isRequired: boolean;
	accepts: (subschema: Record<string, unknown>, value: unknown) => boolean;
}): string | null {
	const { field, acceptanceSchema, renderProperty, isRequired, accepts } =
		params;
	if (!schemaMayAcceptKind(acceptanceSchema, "array")) {
		return `input_schema array property '${field}' cannot be produced by the answer form`;
	}
	if (
		Array.isArray(renderProperty.items) ||
		renderProperty.prefixItems !== undefined
	) {
		return `input_schema array property '${field}' uses tuple items the answer form does not support`;
	}
	const minimumSelections = minimumArraySelections(renderProperty, isRequired);
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
			if (literalValues.length > 0) options = literalValues;
		}
	}

	if (options) {
		if (
			options.length < minimumSelections ||
			options.some(
				(option) => !isFormOptionValue(option) || !accepts(itemSchema, option),
			)
		) {
			return `input_schema array property '${field}' has choices the answer form cannot submit`;
		}
		return null;
	}

	// The generic array input splits comma-separated text and therefore emits
	// strings only. Reject integer/boolean/object/array item schemas — including
	// when those types are hidden behind allOf/anyOf/oneOf.
	if (!schemaMayAcceptKind(itemSchema, "string")) {
		return `input_schema array property '${field}' cannot be produced by the answer form`;
	}
	return null;
}

function validateFormProperty(params: {
	field: string;
	property: Record<string, unknown>;
	isRequired: boolean;
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
			const unwrapped = nonNull[0];
			if (
				unwrapped !== null &&
				typeof unwrapped === "object" &&
				!Array.isArray(unwrapped)
			) {
				renderProperty = unwrapped as Record<string, unknown>;
			}
		}
	}

	// A top-level enum overrides the ordinary input and becomes a typed select.
	if (Array.isArray(renderProperty.enum)) {
		if (
			renderProperty.enum.length === 0 ||
			renderProperty.enum.some(
				(option) =>
					!isFormOptionValue(option) ||
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
				literalValues.some(
					(option) =>
						!isFormOptionValue(option) ||
						!params.accepts(acceptanceSchema, option),
				)
			) {
				return `input_schema property '${params.field}' has choices the answer form cannot submit`;
			}
			return null;
		}
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
	if (!schemaMayAcceptKind(acceptanceSchema, emittedKind)) {
		return `input_schema property '${params.field}' cannot be produced by the answer form`;
	}
	return null;
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

	// The form can only submit declared top-level properties. Bound the root
	// cardinality contract to that exact set so a schema cannot require more
	// answered fields than any supported surface can provide. This also catches
	// contradictory minProperties/maxProperties and required/maxProperties pairs.
	const minimumAnswered = Math.max(
		typeof schema.minProperties === "number" ? schema.minProperties : 0,
		required.length,
	);
	const maximumAnswerable = Math.min(
		Object.keys(properties).length,
		typeof schema.maxProperties === "number"
			? schema.maxProperties
			: Number.POSITIVE_INFINITY,
	);
	if (minimumAnswered > maximumAnswerable) {
		return `input_schema requires at least ${minimumAnswered} answered fields but only ${maximumAnswerable} can be rendered`;
	}
	for (const [field, propertySchema] of Object.entries(properties)) {
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
			isRequired: required.includes(field),
			accepts: compiled.accepts,
		});
		if (propertyError) return propertyError;
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
	// success alone is insufficient: constraints such as `minProperties`, `not`,
	// or `allOf: [{ type: "string" }]` can still make that decision impossible.
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
