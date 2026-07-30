import type { Context } from "hono";
import { routePath } from "hono/route";

/**
 * Fixed-action GET proxies shared by route registration and public-org auth.
 * Keeping both consumers on one table prevents the authorized pair from
 * drifting away from the pair the handler executes.
 *
 * Only pure proxies belong here. Hand-rolled responses need their own public
 * projection before they can be admitted anonymously.
 */
type RestToolRoute = {
	/** Hono route pattern, matched against `routePath(c)`. */
	readonly routePath: string;
	readonly tool: string;
	readonly action: string;
	/** Caller-supplied args. `action` is pinned by `restToolAction`, not here. */
	readonly args: (c: Context) => Record<string, unknown>;
};

export const REST_TOOL_GET_ROUTES: readonly RestToolRoute[] = [
	{
		routePath: "/api/:orgSlug/connections",
		tool: "manage_connections",
		action: "list",
		args: (c) => c.req.query(),
	},
	{
		routePath: "/api/:orgSlug/connections/:id",
		tool: "manage_connections",
		action: "get",
		args: (c) => ({ connection_id: Number(c.req.param("id")) }),
	},
	{
		routePath: "/api/:orgSlug/runs",
		tool: "manage_operations",
		action: "list_runs",
		args: (c) => c.req.query(),
	},
	{
		routePath: "/api/:orgSlug/actions/available",
		tool: "manage_operations",
		action: "list_available",
		args: (c) => c.req.query(),
	},
];

const BY_ROUTE_PATH: ReadonlyMap<string, RestToolRoute> = new Map(
	REST_TOOL_GET_ROUTES.map((route) => [route.routePath, route])
);

/** Resolve the current Hono route; undeclared patterns miss and deny. */
export function resolveRestToolGetRoute(c: Context): RestToolRoute | undefined {
	return BY_ROUTE_PATH.get(routePath(c));
}
