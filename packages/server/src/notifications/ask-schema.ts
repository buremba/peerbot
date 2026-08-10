/**
 * Answer-contract boundary for agent-authored questions.
 *
 * Agent input is both untrusted JSON Schema and a UI contract. We validate the
 * complete schema with AJV, then admit only the small subset the existing answer
 * form faithfully emits: flat primitives, typed choices, simple string arrays,
 * and the TypeBox nullable wrapper. Submitted answers are validated with the
 * same request-scoped AJV compiler.
 */

import { getErrorMessage } from "@lobu/core";
import { createAjv, formatAjvError } from "@lobu/core/ajv";
import type { ValidateFunction } from "ajv";
import {
	DEFAULT_METADATA_LIMITS,
	exceedsValidationLimits,
} from "../utils/metadata-limits";

export interface AskChoice {
	value: string;
	label: string;
}

export type AskAffordance =
	| { kind: "binary" }
	| { kind: "choice"; field: string; choices: AskChoice[] }
	| { kind: "form" };

function readInlineChoices(value: unknown): AskChoice[] | null {
	if (value === null || typeof value !== "object") return null;
	const options = (value as Record<string, unknown>).enum;
	if (!Array.isArray(options) || options.length < 2) return null;
	if (options.some((option) => typeof option !== "string")) return null;
	return options.map((option) => ({ value: option, label: option }));
}

/** Pick the least-powerful answer control that preserves the schema's meaning. */
export function resolveAskAffordance(
	schema: Record<string, unknown> | null | undefined,
): AskAffordance {
	if (!schema) return { kind: "binary" };
	const properties =
		schema.properties !== null &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {};
	const names = Object.keys(properties);
	const required = Array.isArray(schema.required) ? schema.required : [];
	if (names.length === 0) {
		return required.length === 0 ? { kind: "binary" } : { kind: "form" };
	}
	if (names.length === 1 && required.length === 1 && required[0] === names[0]) {
		const field = names[0] as string;
		const choices = readInlineChoices(properties[field]);
		if (choices) return { kind: "choice", field, choices };
	}
	return { kind: "form" };
}

/** Friendly required-field error shown before full AJV answer validation. */
export function findUnansweredRequired(
	schema: Record<string, unknown> | null | undefined,
	input: Record<string, unknown> | null,
): string | null {
	const required = Array.isArray(schema?.required) ? schema.required : [];
	const answer = input ?? {};
	const missing = required.filter((field): field is string => {
		if (typeof field !== "string") return false;
		const value = answer[field];
		return (
			value === undefined ||
			value === null ||
			value === "" ||
			(Array.isArray(value) && value.length === 0)
		);
	});
	if (missing.length === 0) return null;
	return `This question requires an answer for ${missing
		.map((field) => `\`${field}\``)
		.join(", ")}. Approve again with those fields in \`input\`.`;
}

const ASK_SCHEMA_LIMITS = {
	maxDepth: 16,
	maxNodes: 500,
	maxBytes: 32_768,
};

const UNSUPPORTED_KEYWORDS = new Set([
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
	"maxContains",
	"maxProperties",
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

/** Traverse JSON Schema positions, never property names. */
function findUnsupportedKeyword(root: Record<string, unknown>): string | null {
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
		for (const keyword of UNSUPPORTED_KEYWORDS) {
			if (Object.hasOwn(schema, keyword)) return keyword;
		}
		for (const keyword of ["additionalProperties", "contentSchema", "items"]) {
			const child = schema[keyword];
			if (child !== undefined) stack.push(child);
		}
		for (const keyword of ["anyOf", "oneOf"]) {
			const children = schema[keyword];
			if (Array.isArray(children)) stack.push(...children);
		}
		for (const keyword of ["$defs", "definitions", "properties"]) {
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

type CompiledSchema = {
	validate: ValidateFunction;
	accepts: (schema: Record<string, unknown>, value: unknown) => boolean;
};

function compileSchema(
	schema: Record<string, unknown>,
): CompiledSchema | { error: string } {
	if (exceedsValidationLimits(schema, ASK_SCHEMA_LIMITS)) {
		return { error: "input_schema exceeds the allowed size or nesting limits" };
	}
	const unsupported = findUnsupportedKeyword(schema);
	if (unsupported) {
		return {
			error: `input_schema keyword '${unsupported}' is not supported for interactive questions`,
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
			accepts: (candidate, value) => ajv.validate(candidate, value),
		};
	} catch (error) {
		return { error: `input_schema is invalid: ${getErrorMessage(error)}` };
	}
}

type Scalar = string | number | boolean;
interface FormCost {
	nodes: number;
	bytes: number;
}
type PropertyCheck = { cost: FormCost } | { error: string };

function isScalarOption(value: unknown): value is Scalar {
	return (
		(typeof value === "string" && value !== "") ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function scalarBytes(value: Scalar): number {
	return Buffer.byteLength(String(value), "utf8");
}

function literalUnionOptions(value: unknown): unknown[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const options: unknown[] = [];
	for (const branch of value) {
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

function describeNullableProperty(property: Record<string, unknown>): {
	renderSchema: Record<string, unknown>;
	wrapped: boolean;
} {
	if (!Array.isArray(property.anyOf)) {
		return { renderSchema: property, wrapped: false };
	}
	const nonNull = property.anyOf.filter(
		(branch) =>
			branch === null ||
			typeof branch !== "object" ||
			Array.isArray(branch) ||
			(branch as Record<string, unknown>).type !== "null",
	);
	const branch = nonNull[0];
	if (
		nonNull.length !== 1 ||
		nonNull.length === property.anyOf.length ||
		branch === null ||
		typeof branch !== "object" ||
		Array.isArray(branch)
	) {
		return { renderSchema: property, wrapped: false };
	}
	return { renderSchema: branch as Record<string, unknown>, wrapped: true };
}

function checkOptions(params: {
	field: string;
	options: unknown[];
	acceptanceSchema: Record<string, unknown>;
	accepts: CompiledSchema["accepts"];
}): PropertyCheck {
	if (
		params.options.length === 0 ||
		params.options.some(
			(option) =>
				!isScalarOption(option) ||
				!params.accepts(params.acceptanceSchema, option),
		)
	) {
		return {
			error: `input_schema property '${params.field}' has choices the answer form cannot submit`,
		};
	}
	return {
		cost: {
			nodes: 1,
			bytes: Math.min(...(params.options as Scalar[]).map(scalarBytes)),
		},
	};
}

function stringCost(
	field: string,
	schema: Record<string, unknown>,
): PropertyCheck {
	const minimum = Math.max(
		typeof schema.minLength === "number" ? schema.minLength : 0,
		1,
	);
	const maximum =
		typeof schema.maxLength === "number"
			? schema.maxLength
			: Number.POSITIVE_INFINITY;
	return minimum <= maximum
		? { cost: { nodes: 1, bytes: minimum } }
		: {
				error: `input_schema property '${field}' has contradictory length bounds`,
			};
}

function adjacentFiniteNumber(
	value: number,
	direction: "up" | "down",
): number | null {
	if (!Number.isFinite(value)) return null;
	if (value === 0) {
		return direction === "up" ? Number.MIN_VALUE : -Number.MIN_VALUE;
	}
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	const increment = (direction === "up") === value > 0 ? 1n : -1n;
	view.setBigUint64(0, view.getBigUint64(0) + increment);
	const adjacent = view.getFloat64(0);
	return Number.isFinite(adjacent) ? adjacent : null;
}

interface NumericBound {
	value: number;
	exclusive: boolean;
}

function numericCost(
	field: string,
	schema: Record<string, unknown>,
	kind: "number" | "integer",
): PropertyCheck {
	const lower = [
		typeof schema.minimum === "number"
			? { value: schema.minimum, exclusive: false }
			: null,
		typeof schema.exclusiveMinimum === "number"
			? { value: schema.exclusiveMinimum, exclusive: true }
			: null,
	]
		.filter((bound): bound is NumericBound => bound !== null)
		.sort(
			(a, b) => b.value - a.value || Number(b.exclusive) - Number(a.exclusive),
		)[0];
	const upper = [
		typeof schema.maximum === "number"
			? { value: schema.maximum, exclusive: false }
			: null,
		typeof schema.exclusiveMaximum === "number"
			? { value: schema.exclusiveMaximum, exclusive: true }
			: null,
	]
		.filter((bound): bound is NumericBound => bound !== null)
		.sort(
			(a, b) => a.value - b.value || Number(b.exclusive) - Number(a.exclusive),
		)[0];
	if (
		lower &&
		upper &&
		(lower.value > upper.value ||
			(lower.value === upper.value && (lower.exclusive || upper.exclusive)))
	) {
		return {
			error: `input_schema property '${field}' has contradictory numeric bounds`,
		};
	}
	let candidate = lower
		? lower.exclusive
			? adjacentFiniteNumber(lower.value, "up")
			: lower.value
		: upper
			? upper.exclusive
				? adjacentFiniteNumber(upper.value, "down")
				: upper.value
			: 0;
	if (
		candidate !== null &&
		kind === "integer" &&
		!Number.isInteger(candidate)
	) {
		candidate = lower ? Math.ceil(candidate) : Math.floor(candidate);
	}
	const admitted =
		candidate !== null &&
		Number.isFinite(candidate) &&
		(kind === "number" || Number.isInteger(candidate)) &&
		(!lower ||
			(lower.exclusive ? candidate > lower.value : candidate >= lower.value)) &&
		(!upper ||
			(upper.exclusive ? candidate < upper.value : candidate <= upper.value));
	return admitted
		? { cost: { nodes: 1, bytes: 32 } }
		: {
				error: `input_schema property '${field}' has no finite ${kind} within its numeric bounds`,
			};
}

function genericArrayStringRoundTrips(value: string): boolean {
	if (value.includes("\n") || value.includes("\r")) return false;
	const submitted = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return submitted.length === 1 && submitted[0] === value;
}

function checkArrayProperty(params: {
	field: string;
	schema: Record<string, unknown>;
	accepts: CompiledSchema["accepts"];
}): PropertyCheck {
	const { field, schema, accepts } = params;
	if (Object.hasOwn(schema, "const")) {
		return {
			error: `input_schema array property '${field}' uses a constant the answer form does not support`,
		};
	}
	const selections = Math.max(
		typeof schema.minItems === "number" ? schema.minItems : 0,
		1,
	);
	const maximum =
		typeof schema.maxItems === "number"
			? schema.maxItems
			: Number.POSITIVE_INFINITY;
	if (selections > maximum) {
		return {
			error: `input_schema array property '${field}' has an impossible item count`,
		};
	}
	if (
		schema.items === null ||
		typeof schema.items !== "object" ||
		Array.isArray(schema.items)
	) {
		return {
			error: `input_schema array property '${field}' cannot be produced by the answer form`,
		};
	}
	const items = schema.items as Record<string, unknown>;
	const union = Array.isArray(items.anyOf)
		? items.anyOf
		: Array.isArray(items.oneOf)
			? items.oneOf
			: null;
	const options = Array.isArray(items.enum)
		? items.enum
		: literalUnionOptions(union);
	if (union && !options) {
		return {
			error: `input_schema array property '${field}' uses a union the answer form cannot render`,
		};
	}
	if (options) {
		const optionCheck = checkOptions({
			field,
			options,
			acceptanceSchema: items,
			accepts,
		});
		if ("error" in optionCheck) return optionCheck;
		const distinct = new Map<string, number>();
		for (const option of options as Scalar[]) {
			distinct.set(`${typeof option}:${String(option)}`, scalarBytes(option));
		}
		if (distinct.size < selections) {
			return {
				error: `input_schema array property '${field}' has choices the answer form cannot submit`,
			};
		}
		const bytes = [...distinct.values()]
			.sort((a, b) => a - b)
			.slice(0, selections)
			.reduce((sum, value) => sum + value, 0);
		return { cost: { nodes: 1 + selections, bytes } };
	}
	if (Object.hasOwn(items, "const")) {
		const constant = items.const;
		if (
			typeof constant !== "string" ||
			constant === "" ||
			!genericArrayStringRoundTrips(constant) ||
			!accepts(items, constant) ||
			(schema.uniqueItems === true && selections > 1)
		) {
			return {
				error: `input_schema array property '${field}' has a constant the answer form cannot submit`,
			};
		}
		return {
			cost: {
				nodes: 1 + selections,
				bytes: selections * Buffer.byteLength(constant, "utf8"),
			},
		};
	}
	if (items.type !== undefined && items.type !== "string") {
		return {
			error: `input_schema array property '${field}' cannot be produced by the answer form`,
		};
	}
	if (schema.uniqueItems === true && selections > 1) {
		return {
			error: `input_schema array property '${field}' cannot be produced by the answer form`,
		};
	}
	const itemCost = stringCost(field, items);
	if ("error" in itemCost) {
		return {
			error: `input_schema array property '${field}' cannot be produced by the answer form`,
		};
	}
	return {
		cost: {
			nodes: 1 + selections,
			bytes: selections * itemCost.cost.bytes,
		},
	};
}

function checkFormProperty(params: {
	field: string;
	property: Record<string, unknown>;
	accepts: CompiledSchema["accepts"];
}): PropertyCheck {
	const { field, property, accepts } = params;
	const { renderSchema, wrapped } = describeNullableProperty(property);
	if (wrapped) {
		const unsupportedSibling = Object.keys(property).find(
			(keyword) => !NULLABLE_WRAPPER_ANNOTATIONS.has(keyword),
		);
		if (unsupportedSibling) {
			return {
				error: `input_schema property '${field}' nullable wrapper sibling '${unsupportedSibling}' is not supported by the answer form`,
			};
		}
	}
	if (Array.isArray(renderSchema.enum)) {
		return checkOptions({
			field,
			options: renderSchema.enum,
			acceptanceSchema: property,
			accepts,
		});
	}
	if (Array.isArray(renderSchema.anyOf)) {
		const options = literalUnionOptions(renderSchema.anyOf);
		return options
			? checkOptions({
					field,
					options,
					acceptanceSchema: property,
					accepts,
				})
			: {
					error: `input_schema property '${field}' uses a union the answer form cannot render`,
				};
	}
	if (Array.isArray(renderSchema.oneOf)) {
		return {
			error: `input_schema property '${field}' uses oneOf, which the answer form cannot render`,
		};
	}
	if (renderSchema.type === "array") {
		return checkArrayProperty({ field, schema: renderSchema, accepts });
	}
	if (renderSchema.type === "object") {
		return {
			error: `input_schema property '${field}' must not contain a nested object`,
		};
	}
	if (
		renderSchema.type !== undefined &&
		!["string", "number", "integer", "boolean"].includes(
			String(renderSchema.type),
		)
	) {
		return {
			error: `input_schema property '${field}' cannot be produced by the answer form`,
		};
	}
	if (Object.hasOwn(renderSchema, "const")) {
		const constant = renderSchema.const;
		if (
			!isScalarOption(constant) ||
			!accepts(property, constant) ||
			(renderSchema.type === undefined && typeof constant !== "string")
		) {
			return {
				error: `input_schema property '${field}' has a constant the answer form cannot submit`,
			};
		}
		return { cost: { nodes: 1, bytes: scalarBytes(constant) } };
	}
	if (renderSchema.type === "number" || renderSchema.type === "integer") {
		return numericCost(field, renderSchema, renderSchema.type);
	}
	if (renderSchema.type === "boolean") {
		return { cost: { nodes: 1, bytes: 5 } };
	}
	return stringCost(field, renderSchema);
}

/** Validate the contract before a pending run/event is durably created. */
export function validateAskInputSchema(
	schema: Record<string, unknown>,
): string | null {
	const compiled = compileSchema(schema);
	if ("error" in compiled) return compiled.error;
	if (schema.type !== undefined && schema.type !== "object") {
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
	const missing = required.filter((field) => !Object.hasOwn(properties, field));
	if (missing.length > 0) {
		return `input_schema requires fields missing from properties: ${missing.join(", ")}`;
	}

	const costs = new Map<string, FormCost>();
	for (const [field, property] of Object.entries(properties)) {
		if (Object.hasOwn(Object.prototype, field)) {
			return `input_schema property name '${field}' is not supported by the answer form`;
		}
		if (
			property === null ||
			typeof property !== "object" ||
			Array.isArray(property)
		) {
			return `input_schema property '${field}' must be a renderable schema`;
		}
		const checked = checkFormProperty({
			field,
			property: property as Record<string, unknown>,
			accepts: compiled.accepts,
		});
		if ("error" in checked) return checked.error;
		costs.set(field, checked.cost);
	}

	const minimumAnswer = required.reduce<FormCost>(
		(total, field) => {
			const cost = costs.get(field) as FormCost;
			return {
				nodes: total.nodes + cost.nodes,
				bytes: total.bytes + cost.bytes + Buffer.byteLength(field, "utf8"),
			};
		},
		{ nodes: 0, bytes: 0 },
	);
	if (
		minimumAnswer.nodes > DEFAULT_METADATA_LIMITS.maxNodes ||
		minimumAnswer.bytes > DEFAULT_METADATA_LIMITS.maxBytes
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
	const compiled = compileSchema(schema);
	if ("error" in compiled) return compiled.error;
	if (compiled.validate(answer)) return null;
	const firstError = compiled.validate.errors?.[0];
	return firstError
		? `Answer ${formatAjvError(firstError)}`
		: "Answer does not match input_schema";
}
