/**
 * Unified Integrations Routes (Skills + MCP)
 *
 * Single registry endpoint that searches both skills and MCPs in parallel.
 * Also includes skill fetching and MCP by-ID lookup.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { McpRegistryService } from "../../services/mcp-registry";
import { SkillsFetcherService } from "../../services/skills-fetcher";
import { verifySettingsSession } from "./settings-auth";

const TAG = "Integrations";
const ErrorResponse = z.object({ error: z.string() });

const registryRoute = createRoute({
  method: "get",
  path: "/registry",
  tags: [TAG],
  summary: "Browse/search integrations registry (skills + MCPs)",
  description:
    "Returns curated skills and MCPs if no query, or searches both registries in parallel if q provided",
  request: {
    query: z.object({
      token: z.string().optional(),
      q: z
        .string()
        .optional()
        .openapi({ description: "Search query (omit for curated)" }),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Integrations",
      content: {
        "application/json": {
          schema: z.object({
            skills: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().optional(),
              })
            ),
            mcps: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string(),
                type: z.string().optional(),
              })
            ),
            source: z.enum(["curated", "search"]),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const skillFetchRoute = createRoute({
  method: "post",
  path: "/skills/fetch",
  tags: [TAG],
  summary: "Fetch skill metadata from ClawHub",
  description: "Fetches skill name, description, and content by slug",
  request: {
    query: z.object({ token: z.string().optional() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            repo: z
              .string()
              .openapi({ description: "ClawHub skill slug (e.g., 'pdf')" }),
            refresh: z
              .boolean()
              .optional()
              .openapi({ description: "Force refresh" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Skill metadata",
      content: {
        "application/json": {
          schema: z.object({
            repo: z.string(),
            name: z.string(),
            description: z.string(),
            content: z.string(),
            fetchedAt: z.number(),
          }),
        },
      },
    },
    400: {
      description: "Invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const mcpByIdRoute = createRoute({
  method: "get",
  path: "/mcps/:id",
  tags: [TAG],
  summary: "Get MCP server by ID",
  description:
    "Returns full MCP server configuration including setup instructions",
  request: {
    query: z.object({ token: z.string().optional() }),
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "MCP server details",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            type: z.enum(["oauth", "command", "api-key", "none"]),
            config: z.record(z.string(), z.unknown()),
            setupInstructions: z.string().optional(),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export function createIntegrationsRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();
  const skillsFetcher = new SkillsFetcherService();
  const mcpRegistry = new McpRegistryService();

  app.openapi(registryRoute, async (c): Promise<any> => {
    const { q, limit } = c.req.valid("query");
    if (!verifySettingsSession(c))
      return c.json({ error: "Unauthorized" }, 401);

    const maxLimit = Math.min(parseInt(limit || "20", 10), 50);

    if (q) {
      const [skills, mcpResults] = await Promise.all([
        skillsFetcher.searchSkills(q, maxLimit),
        Promise.resolve(mcpRegistry.search(q, maxLimit)),
      ]);
      return c.json({
        skills,
        mcps: mcpResults.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          type: m.type,
        })),
        source: "search",
      });
    }

    const mcps = mcpRegistry.getCurated();
    return c.json({
      skills: skillsFetcher.getCuratedSkills(),
      mcps: mcps.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        type: m.type,
      })),
      source: "curated",
    });
  });

  app.openapi(skillFetchRoute, async (c): Promise<any> => {
    if (!verifySettingsSession(c))
      return c.json({ error: "Unauthorized" }, 401);

    const { repo, refresh } = c.req.valid("json");
    if (!repo?.trim()) return c.json({ error: "Missing skill slug" }, 400);

    try {
      if (refresh) skillsFetcher.clearCache(repo);
      const metadata = await skillsFetcher.fetchSkill(repo);
      return c.json({
        repo,
        name: metadata.name,
        description: metadata.description,
        content: metadata.content,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed" }, 400);
    }
  });

  app.openapi(mcpByIdRoute, async (c): Promise<any> => {
    if (!verifySettingsSession(c))
      return c.json({ error: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const mcp = mcpRegistry.getById(id);
    if (!mcp) return c.json({ error: "MCP not found" }, 404);

    return c.json({
      id: mcp.id,
      name: mcp.name,
      description: mcp.description,
      type: mcp.type,
      config: mcp.config,
      setupInstructions: mcp.setupInstructions,
    });
  });

  return app;
}
