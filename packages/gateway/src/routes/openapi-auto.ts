import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

type OpenApiDefinition =
  | { type: "route"; route: { method: string; path: string } }
  | { type: string; route?: { method: string; path: string } };

// Internal route prefixes - worker-facing, excluded from public docs
const INTERNAL_PREFIXES = ["/api/proxy", "/internal", "/worker", "/mcp"];

// Routes that render HTML pages or are browser redirects (not API endpoints)
const EXCLUDED_ROUTES = [
  "/", // Landing page
  "/settings", // HTML settings page
  "/api/v1/oauth/providers/{provider}/login", // OAuth redirect
];

function isInternalRoute(path: string): boolean {
  return INTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isExcludedRoute(path: string): boolean {
  return EXCLUDED_ROUTES.includes(path);
}

function normalizePath(path: string): string {
  let normalized = path.replace(/:([A-Za-z0-9_]+)(?:\{[^}]+\})?/g, "{$1}");
  normalized = normalized.replace(/\/\*/g, "/{wildcard}");
  normalized = normalized.replace(/\*/g, "{wildcard}");
  return normalized;
}

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    if (match[1]) {
      params.push(match[1]);
    }
  }
  return params;
}

/**
 * Derive an appropriate tag for routes not already defined via app.openapi.
 * Maps route paths to API documentation categories.
 */
function deriveTag(path: string): string {
  // System routes
  if (
    path.startsWith("/health") ||
    path.startsWith("/ready") ||
    path.startsWith("/metrics")
  ) {
    return "System";
  }

  // Auth routes
  if (path.startsWith("/api/v1/auth/")) {
    return "Auth";
  }

  // Agent routes
  if (path.startsWith("/api/v1/agents")) {
    if (path.includes("/channels")) return "Channels";
    if (path.includes("/exec")) return "Agent Exec";
    if (path.includes("/messages") || path.includes("/interactions"))
      return "Agent Messages";
    return "Agents";
  }

  // Skills utility routes
  if (path.startsWith("/api/v1/skills")) {
    return "Skills";
  }

  // OAuth utility routes
  if (path.startsWith("/api/v1/oauth")) {
    return "OAuth";
  }

  // Messaging routes
  if (
    path.startsWith("/api/messaging/") ||
    path.startsWith("/api/v1/messaging/")
  ) {
    return "Messaging";
  }

  // MCP routes
  if (path.startsWith("/mcp/")) {
    return "MCP Servers";
  }

  return "Other";
}

/**
 * Register OpenAPI paths for routes not already defined via app.openapi.
 * Internal routes (worker-facing) are excluded from public docs.
 */
export function registerAutoOpenApiRoutes(app: OpenAPIHono): void {
  const registered = new Set<string>();
  const definitions = app.openAPIRegistry
    .definitions as unknown as OpenApiDefinition[];

  for (const def of definitions) {
    if (def.type === "route" && def.route) {
      const method = def.route.method.toLowerCase();
      const path = normalizePath(def.route.path);
      registered.add(`${method} ${path}`);
    }
  }

  for (const route of app.routes) {
    const method = route.method.toLowerCase();
    if (method === "all") {
      continue;
    }

    const path = normalizePath(route.path);
    const key = `${method} ${path}`;

    if (registered.has(key)) {
      continue;
    }

    // Skip internal routes - they shouldn't be in public docs
    if (isInternalRoute(path)) {
      continue;
    }

    // Skip excluded routes (HTML pages, OAuth redirects)
    if (isExcludedRoute(path)) {
      continue;
    }

    const params = extractPathParams(path);
    const paramsSchema =
      params.length > 0
        ? z.object(
            Object.fromEntries(params.map((param) => [param, z.string()]))
          )
        : undefined;

    const routeConfig: RouteConfig = {
      method: method as RouteConfig["method"],
      path,
      tags: [deriveTag(path)],
      summary: `${method.toUpperCase()} ${path}`,
      request: paramsSchema ? { params: paramsSchema } : undefined,
      responses: {
        200: { description: "OK" },
      },
    };

    app.openAPIRegistry.registerPath(routeConfig);
    registered.add(key);
  }
}

/**
 * Get all registered routes for debugging.
 * Returns both public and internal routes.
 */
export function getAllRoutes(app: OpenAPIHono): Array<{
  method: string;
  path: string;
  internal: boolean;
}> {
  return app.routes
    .filter((r) => r.method.toLowerCase() !== "all")
    .map((r) => ({
      method: r.method.toUpperCase(),
      path: normalizePath(r.path),
      internal: isInternalRoute(r.path),
    }));
}
