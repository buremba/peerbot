/**
 * Answer contract for agent-authored questions.
 *
 * The web answer form deliberately supports a small JSON Schema subset: flat
 * primitive fields, scalar enums, string arrays, and optional TypeBox-nullable
 * wrappers. This module admits exactly that subset, then uses request-scoped AJV
 * validation for every submitted answer.
 */

import { getErrorMessage } from "@lobu/core";
import { createAjv, formatAjvError } from "@lobu/core/ajv";
import type { ValidateFunction } from "ajv";
import { exceedsValidationLimits } from "../utils/metadata-limits";

export interface AskChoice {
	value: string;
	label: string;
}

export type AskAffordance =
	| { kind: "binary" }
	| { kind: "choice"; field: string; choices: AskChoice[] }
	| { kind: "form" };

export const CURRENT_ASK_SCHEMA_VERSION = 1;

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
	const properties = readProperties(schema);
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

function findUnansweredRequired(
	schema: Record<string, unknown>,
	input: Record<string, unknown> | null,
): string | null {
	const required = Array.isArray(schema.required) ? schema.required : [];
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

/**
 * Constraints outside the form's explicit contract fail closed. This avoids a
 * second, server-side implementation of JSON Schema satisfiability and keeps
 * already-admitted v1 asks stable across renderer changes.
 */
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
	"const",
	"contains",
	"dependencies",
	"dependentRequired",
	"dependentSchemas",
	"else",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"format",
	"formatExclusiveMaximum",
	"formatExclusiveMinimum",
	"formatMaximum",
	"formatMinimum",
	"if",
	"maxContains",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minContains",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf",
	"not",
	"oneOf",
	"pattern",
	"patternProperties",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
	"uniqueItems",
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

/** Traverse schema positions, never property names such as a field named pattern. */
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
		const unsupported = Object.keys(schema).find((keyword) =>
			UNSUPPORTED_KEYWORDS.has(keyword),
		);
		if (unsupported) return unsupported;
		for (const keyword of ["additionalProperties", "contentSchema", "items"]) {
			const child = schema[keyword];
			if (child !== undefined) stack.push(child);
		}
		if (Array.isArray(schema.anyOf)) stack.push(...schema.anyOf);
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

function readProperties(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	return schema.properties !== null &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
		? (schema.properties as Record<string, unknown>)
		: {};
}

function isScalarOption(value: unknown): boolean {
	return (
		(typeof value === "string" && value !== "") ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function checkOptions(params: {
	field: string;
	options: unknown[];
	acceptanceSchema: Record<string, unknown>;
	accepts: CompiledSchema["accepts"];
}): string | null {
	const valid =
		params.options.length > 0 &&
		params.options.every(
			(option) =>
				isScalarOption(option) &&
				params.accepts(params.acceptanceSchema, option),
		);
	return valid
		? null
		: `input_schema property '${params.field}' has choices the answer form cannot submit`;
}

function unwrapNullableProperty(property: Record<string, unknown>): {
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

function checkArrayProperty(params: {
	field: string;
	schema: Record<string, unknown>;
	accepts: CompiledSchema["accepts"];
}): string | null {
	const { field, schema, accepts } = params;
	if (
		schema.items === null ||
		typeof schema.items !== "object" ||
		Array.isArray(schema.items)
	) {
		return `input_schema array property '${field}' must declare renderable items`;
	}
	const items = schema.items as Record<string, unknown>;
	if (Array.isArray(items.anyOf)) {
		return `input_schema array property '${field}' uses a union the answer form cannot render`;
	}
	if (Array.isArray(items.enum)) {
		return checkOptions({
			field,
			options: items.enum,
			acceptanceSchema: items,
			accepts,
		});
	}
	return items.type === undefined || items.type === "string"
		? null
		: `input_schema array property '${field}' can only use string items or scalar enum items`;
}

function checkFormProperty(params: {
	field: string;
	property: Record<string, unknown>;
	required: boolean;
	accepts: CompiledSchema["accepts"];
}): string | null {
	const { field, property, required, accepts } = params;
	const { renderSchema, wrapped } = unwrapNullableProperty(property);
	if (wrapped) {
		const unsupportedSibling = Object.keys(property).find(
			(keyword) => !NULLABLE_WRAPPER_ANNOTATIONS.has(keyword),
		);
		if (unsupportedSibling) {
			return `input_schema property '${field}' nullable wrapper sibling '${unsupportedSibling}' is not supported by the answer form`;
		}
		if (required) {
			return `input_schema required nullable property '${field}' cannot be produced by the answer form`;
		}
	}
	if (Array.isArray(renderSchema.anyOf)) {
		return `input_schema property '${field}' uses a union the answer form cannot render`;
	}
	if (Array.isArray(renderSchema.enum)) {
		return checkOptions({
			field,
			options: renderSchema.enum,
			acceptanceSchema: property,
			accepts,
		});
	}
	if (renderSchema.type === "array") {
		return checkArrayProperty({ field, schema: renderSchema, accepts });
	}
	if (renderSchema.type === "object") {
		return `input_schema property '${field}' must not contain a nested object`;
	}
	return renderSchema.type === undefined ||
		["string", "number", "integer", "boolean"].includes(
			String(renderSchema.type),
		)
		? null
		: `input_schema property '${field}' cannot be produced by the answer form`;
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
	if (Array.isArray(schema.enum)) {
		return "input_schema root enum constraints are not supported by the answer form";
	}
	if (Array.isArray(schema.anyOf)) {
		return "input_schema root unions are not supported by the answer form";
	}

	const properties = readProperties(schema);
	const required = Array.isArray(schema.required)
		? schema.required.filter(
				(field): field is string => typeof field === "string",
			)
		: [];
	const missing = required.filter((field) => !Object.hasOwn(properties, field));
	if (missing.length > 0) {
		return `input_schema requires fields missing from properties: ${missing.join(", ")}`;
	}

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
		const error = checkFormProperty({
			field,
			property: property as Record<string, unknown>,
			required: required.includes(field),
			accepts: compiled.accepts,
		});
		if (error) return error;
	}

	const affordance = resolveAskAffordance(schema);
	if (affordance.kind === "choice") {
		for (const choice of affordance.choices) {
			if (!compiled.validate({ [affordance.field]: choice.value })) {
				return `input_schema choice '${choice.value}' does not satisfy the declared schema`;
			}
		}
	}
	return null;
}

function validateAskAnswer(
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

/** Keep pre-v1 pending asks on their original required-field-only contract. */
export function validateAskAnswerForProposal(
	proposal: {
		input_schema: Record<string, unknown>;
		input_schema_validation_version?: number;
	},
	input: Record<string, unknown> | null,
): string | null {
	const requiredError = findUnansweredRequired(proposal.input_schema, input);
	if (requiredError) return requiredError;
	return proposal.input_schema_validation_version === CURRENT_ASK_SCHEMA_VERSION
		? validateAskAnswer(proposal.input_schema, input)
		: null;
}
