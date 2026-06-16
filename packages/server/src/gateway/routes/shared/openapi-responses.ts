/**
 * Shared OpenAPI response building blocks.
 *
 * Collapses the stamped-out
 *   `4xx: { description, content: { "application/json": { schema } } }`
 * blocks that every `createRoute` definition repeats. The shape and the
 * canonical `{ error }` schema were previously redeclared per route file.
 */

import { z } from "@hono/zod-openapi";

/**
 * Canonical flat error response: `{ error: string }`.
 *
 * The single source for the `{ error }` shape used by connection, config, and
 * most CRUD routes. Routes with a richer error envelope (e.g. agent.ts's
 * `{ success, error, details? }`) pass their own schema to `errorResponses`.
 */
export const ErrorResponseSchema = z.object({ error: z.string() });

/**
 * A single OpenAPI JSON response block for `schema`.
 */
type JsonResponseBlock<Schema> = {
  description: string;
  content: { "application/json": { schema: Schema } };
};

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
 * richer envelope.
 *
 * The return type preserves the exact set of status-code keys (via the
 * `Codes` generic) so the spread into `createRoute({ responses })` keeps
 * per-code precision and `app.openapi(route, handler)` still infers a precise
 * handler return type — a plain `Record<number, …>` would widen it.
 */
export function errorResponses<Schema, Codes extends number>(
  schema: Schema,
  descriptions: Record<Codes, string>
): { [Code in Codes]: JsonResponseBlock<Schema> } {
  const out = {} as { [Code in Codes]: JsonResponseBlock<Schema> };
  for (const [code, description] of Object.entries(descriptions) as [
    `${Codes}`,
    string,
  ][]) {
    out[Number(code) as Codes] = {
      description,
      content: { "application/json": { schema } },
    };
  }
  return out;
}
