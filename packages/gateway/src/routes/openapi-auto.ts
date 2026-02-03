import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

type OpenApiDefinition =
  | { type: "route"; route: { method: string; path: string } }
  | { type: string; route?: { method: string; path: string } };

function normalizePath(path: string): string {
  // Convert Hono-style params (:id or :id{.+}) to OpenAPI {id}
  let normalized = path.replace(/:([A-Za-z0-9_]+)(?:\{[^}]+\})?/g, "{$1}");
  // Convert wildcard to OpenAPI-style param
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

function deriveTag(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "System";
  }

  const first = parts[0] || "";
  const second = parts[1] || "";
  const third = parts[2] || "";

  // Handle /api/v1/* structure
  if (first === "api" && second === "v1" && third) {
    const resource = third;
    // Map to proper tag names
    if (resource === "agents") {
      // Check for nested resources
      if (parts.includes("channels")) return "Channels";
      if (parts.includes("skills")) return "Skills";
      if (parts.includes("schedules")) return "Schedules";
      if (parts.includes("github")) return "GitHub";
      if (parts.includes("settings")) return "Settings";
      return "Agents";
    }
    if (resource === "messaging") return "Messaging";
    if (resource === "settings") return "Settings";
    if (resource === "skills") return "Skills";
    if (resource === "auth") return "Auth";
    // Capitalize first letter
    return resource.charAt(0).toUpperCase() + resource.slice(1);
  }

  // Handle /internal/* routes
  if (first === "internal") {
    return "Internal";
  }

  // Handle health/metrics/etc
  if (["health", "ready", "metrics"].includes(first)) {
    return "System";
  }

  // Handle settings page
  if (first === "settings") {
    return "Settings";
  }

  // Default: capitalize first segment
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Register OpenAPI paths for all Hono routes not already defined via app.openapi.
 * This keeps a single auto-generated OpenAPI schema for the entire gateway.
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
