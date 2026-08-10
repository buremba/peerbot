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

function compileAskInputSchema(
	schema: Record<string, unknown>,
): { validate: ValidateFunction } | { error: string } {
	// Both the schema and the eventual answer are untrusted agent/user input.
	// Bound the schema before AJV walks it, and build a request-scoped AJV so an
	// unbounded stream of unique question schemas cannot grow a process-global
	// validator cache for the lifetime of a gateway replica.
	if (exceedsValidationLimits(schema)) {
		return { error: "input_schema exceeds the allowed size or nesting limits" };
	}
	try {
		const ajv = createAjv({
			allErrors: false,
			strict: false,
			coerceTypes: false,
		});
		return { validate: ajv.compile(schema) };
	} catch (error) {
		return { error: `input_schema is invalid: ${getErrorMessage(error)}` };
	}
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
		? schema.required.filter((field): field is string => typeof field === "string")
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
			propertySchema !== null &&
			typeof propertySchema === "object" &&
			!Array.isArray(propertySchema)
		) {
			const property = propertySchema as Record<string, unknown>;
			const propertyType = property.type;
			const itemSchema = property.items as Record<string, unknown> | undefined;
			const itemType = itemSchema?.type;
			const containsObject =
				propertyType === "object" ||
				(Array.isArray(propertyType) && propertyType.includes("object")) ||
				itemType === "object" ||
				(Array.isArray(itemType) && itemType.includes("object"));
			if (containsObject) {
				return `input_schema property '${field}' must not contain a nested object`;
			}
		}
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
		clientId: params.ctx.tokenType === "oauth" ? (params.ctx.clientId ?? null) : null,
	});

	return { runId, interactionEventId: Number(event.id) };
}
