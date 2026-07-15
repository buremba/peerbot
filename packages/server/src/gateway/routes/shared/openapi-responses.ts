/**
 * Shared response building blocks for `defineRoute`.
 *
 * Collapses the repeated `{ description, schema }` error blocks and the
 * canonical `{ error }` schema that every route otherwise redeclares. The blocks
 * match `defineRoute`'s `ResponseSpec` shape (`{ description, schema? }`), which
 * the doc builder projects into OpenAPI `content` entries.
 */

import { type TSchema, Type } from "@sinclair/typebox";
import type { ResponseSpec } from "./define-route.js";

/**
 * Canonical flat error response: `{ error: string }`.
 *
 * The single source for the `{ error }` shape used by connection, config, and
 * most CRUD routes. Routes with a richer error envelope (e.g. agent.ts's
 * `{ success, error, details? }`) pass their own schema to `errorResponses`.
 */
export const ErrorResponseSchema = Type.Object({ error: Type.String() });

/**
 * Build a set of error-response blocks keyed by HTTP status code.
 *
 * Usage:
 *   responses: {
 *     200: { ... },
 *     ...errorResponses(ErrorResponseSchema, { 401: "Unauthorized", 404: "Not found" }),
 *   }
 *
 * `schema` is the error body schema; pass a custom schema for routes with a
 * richer envelope. The `Codes` generic preserves the exact status-code key set.
 */
export function errorResponses<Codes extends number>(
	schema: TSchema,
	descriptions: Record<Codes, string>,
): { [Code in Codes]: ResponseSpec } {
	const out = {} as { [Code in Codes]: ResponseSpec };
	for (const [code, description] of Object.entries(descriptions) as [
		`${Codes}`,
		string,
	][]) {
		out[Number(code) as Codes] = { description, schema };
	}
	return out;
}
