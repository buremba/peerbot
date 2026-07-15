/**
 * `defineRoute` — a thin, TypeBox-native replacement for `@hono/zod-openapi`'s
 * `createRoute` + `OpenAPIHono`.
 *
 * Why hand-rolled: the whole gateway contract is TypeBox (the dispatch-tool
 * surface, `@lobu/core/contracts`, the validate-args chokepoint). `zod-openapi`
 * was the last place a SECOND schema library (Zod) lived. `defineRoute` lets the
 * agent-session routes declare their request/response schemas in the same
 * TypeBox the rest of the server uses, so ONE OpenAPI document is projected from
 * ONE schema source with no hand-copied wire types.
 *
 * It does two things:
 *   (a) registers a plain Hono handler behind a validation middleware that runs
 *       the same TypeBox coercion+check the tool dispatch uses, stashing the
 *       validated `json` / `param` / `query` on the context for the handler; and
 *   (b) records the route's `{method, path, request, responses}` in a registry
 *       the doc builder concatenates with `generateStrictToolPaths()`.
 *
 * No new dependency: OpenAPI projection is a direct walk of the TypeBox schemas
 * (which are already JSON-Schema 2020-12 objects) plus the `{path → {method →
 * operation}}` assembly `getOpenAPI31Document` used to do internally.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import { ToolUserError } from "../../../utils/errors.js";
import { deepCopyStrict } from "../../../utils/schema-copy.js";

type Method = "get" | "post" | "put" | "patch" | "delete";

/** A single response entry: the JSON body schema + a description. */
export interface ResponseSpec {
	description: string;
	schema?: TSchema;
}

export interface RouteSpec<
	TBody extends TSchema | undefined = TSchema | undefined,
	TParams extends TSchema | undefined = TSchema | undefined,
	TQuery extends TSchema | undefined = TSchema | undefined,
> {
	method: Method;
	/** OpenAPI path with `{param}` placeholders (e.g. `/api/v1/agents/{agentId}`). */
	path: string;
	/**
	 * Router-relative registration path, when the route lives on a sub-router
	 * mounted under a prefix (e.g. the agent-config router registers `/` but is
	 * mounted at `/api/v1/agents/:agentId/config`). Defaults to `path`. The doc
	 * always uses `path`, so the OpenAPI document shows the full mounted URL.
	 */
	honoPath?: string;
	tags?: string[];
	summary?: string;
	description?: string;
	/** Emit `security: [{ bearerAuth: [] }]` on the operation. */
	bearerAuth?: boolean;
	request?: {
		body?: TBody;
		params?: TParams;
		query?: TQuery;
	};
	/**
	 * Document `request.body` in the OpenAPI doc but DO NOT auto-validate it in
	 * the middleware. For content-negotiating handlers (e.g. the send-message
	 * route accepts multipart form-data OR JSON): eager `c.req.json()` would 400
	 * a multipart request before the handler can branch on Content-Type. Such
	 * handlers parse + validate the body themselves.
	 */
	skipBodyValidation?: boolean;
	/** Response bodies keyed by status code. */
	responses: Record<number, ResponseSpec>;
}

/** Shape the validation middleware stashes on the context for handlers. */
export interface ValidatedRequest<
	TBody = unknown,
	TParams = unknown,
	TQuery = unknown,
> {
	json: TBody;
	param: TParams;
	query: TQuery;
}

const VALIDATED = "validatedRequest" as const;

/**
 * Read the validated request the `defineRoute` middleware stashed. Typed by the
 * route's schemas at the call site (`getValidated<Static<typeof BodySchema>>`).
 */
export function getValidated<
	TBody = unknown,
	TParams = unknown,
	TQuery = unknown,
>(c: Context): ValidatedRequest<TBody, TParams, TQuery> {
	return (c as unknown as { get(k: string): unknown }).get(
		VALIDATED,
	) as ValidatedRequest<TBody, TParams, TQuery>;
}

/**
 * Coerce + validate `value` against `schema`, throwing a 400 ToolUserError with
 * the first error path on mismatch. Mirrors `validateToolArgs`' Convert→Check
 * pipeline so route bodies and tool args validate identically.
 */
function coerceAndCheck(schema: TSchema, value: unknown, where: string): unknown {
	const coerced = Value.Convert(schema, value);
	if (Value.Check(schema, coerced)) return Value.Clean(schema, coerced);
	const first = Value.Errors(schema, coerced).First();
	const detail = first
		? `${first.path || "(root)"} ${first.message}`.trim()
		: "does not match the expected shape";
	throw new ToolUserError(`Invalid ${where}: ${detail}`, 400);
}

/** The route registry, projected into the OpenAPI document by `buildRoutePaths`. */
const ROUTE_REGISTRY: RouteSpec[] = [];

/**
 * Register a route on `app` and record it for the OpenAPI document.
 *
 * The handler receives the Hono `Context`; it reads validated input via
 * `getValidated<…>(c)` instead of `c.req.valid(...)`.
 */
export function defineRoute<
	E extends Env,
	TBody extends TSchema | undefined,
	TParams extends TSchema | undefined,
	TQuery extends TSchema | undefined,
>(
	app: Hono<E>,
	spec: RouteSpec<TBody, TParams, TQuery>,
	handler: (c: Context<E>) => Response | Promise<Response>,
): void {
	ROUTE_REGISTRY.push(spec as unknown as RouteSpec);

	const middleware: MiddlewareHandler<E> = async (c, next) => {
		// `skipBodyValidation` documents the body but leaves parsing to the handler
		// (content-negotiating routes — see the flag's doc).
		const bodySchema = spec.skipBodyValidation ? undefined : spec.request?.body;
		const paramSchema = spec.request?.params;
		const querySchema = spec.request?.query;

		let json: unknown;
		if (bodySchema) {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json({ error: "Invalid or missing JSON body" }, 400);
			}
			try {
				json = coerceAndCheck(bodySchema, raw, "request body");
			} catch (err) {
				return c.json(
					{ error: err instanceof Error ? err.message : String(err) },
					400,
				);
			}
		}

		let param: unknown;
		if (paramSchema) {
			try {
				param = coerceAndCheck(paramSchema, c.req.param(), "path parameters");
			} catch (err) {
				return c.json(
					{ error: err instanceof Error ? err.message : String(err) },
					400,
				);
			}
		}

		let query: unknown;
		if (querySchema) {
			try {
				query = coerceAndCheck(
					querySchema,
					c.req.query() as Record<string, string>,
					"query parameters",
				);
			} catch (err) {
				return c.json(
					{ error: err instanceof Error ? err.message : String(err) },
					400,
				);
			}
		}

		// `VALIDATED` isn't declared in this generic `E`'s `Variables` map; the
		// typed accessor is `getValidated(c)`, so set through a widened ref.
		(c as unknown as { set(k: string, v: unknown): void }).set(VALIDATED, {
			json,
			param,
			query,
		});
		await next();
		return;
	};

	// Register through a minimal structural shim. Hono's method/`.on` overloads
	// thread a chain of path/handler generics that isn't expressible from this
	// helper's `E` — but the runtime contract is just "(method, path, mw,
	// handler)", and the middleware validates every body/param before the handler
	// runs, so the schemas (not TS's route generics) are the contract here.
	const registrar = app as unknown as Record<
		Method,
		(path: string, ...handlers: MiddlewareHandler[]) => unknown
	>;
	// OpenAPI templating uses `{param}`; Hono routing uses `:param`. The registry
	// (and `buildRoutePaths`) keeps the `{param}` form for the doc; Hono gets the
	// `:param` form so requests actually match.
	const honoPath = (spec.honoPath ?? spec.path).replace(/\{([^}]+)\}/g, ":$1");
	registrar[spec.method](
		honoPath,
		middleware,
		handler as unknown as MiddlewareHandler,
	);
}

/**
 * Project the registered routes into an OpenAPI 3.1 `paths` object.
 *
 * Every schema is embedded through `deepCopyStrict` — the SAME projector
 * `generateStrictToolPaths()` uses for the dispatch-tool surface — so the two
 * halves of the merged doc share one JSON-Schema-embedding path (drops `$id` /
 * `static` TypeBox internals and `x-hidden` server-only fields). Placeholders
 * `{x}` in the path stay as-is (OpenAPI path templating).
 */
export function buildRoutePaths(): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const spec of ROUTE_REGISTRY) {
		const op: Record<string, unknown> = {};
		if (spec.tags) op.tags = spec.tags;
		if (spec.summary) op.summary = spec.summary;
		if (spec.description) op.description = spec.description;
		if (spec.bearerAuth) op.security = [{ bearerAuth: [] }];

		const parameters: unknown[] = [];
		for (const [loc, schema] of [
			["path", spec.request?.params],
			["query", spec.request?.query],
		] as const) {
			if (!schema || !("properties" in schema)) continue;
			const obj = schema as unknown as {
				properties: Record<string, TSchema>;
				required?: string[];
			};
			const required = new Set(obj.required ?? []);
			for (const [name, propSchema] of Object.entries(obj.properties)) {
				parameters.push({
					name,
					in: loc,
					required: loc === "path" ? true : required.has(name),
					schema: deepCopyStrict(propSchema),
				});
			}
		}
		if (parameters.length > 0) op.parameters = parameters;

		if (spec.request?.body) {
			op.requestBody = {
				required: true,
				content: {
					"application/json": { schema: deepCopyStrict(spec.request.body) },
				},
			};
		}

		const responses: Record<string, unknown> = {};
		for (const [code, res] of Object.entries(spec.responses)) {
			responses[code] = res.schema
				? {
						description: res.description,
						content: {
							"application/json": { schema: deepCopyStrict(res.schema) },
						},
					}
				: { description: res.description };
		}
		op.responses = responses;

		const pathItem = paths[spec.path] ?? (paths[spec.path] = {});
		pathItem[spec.method] = op;
	}
	return paths;
}
