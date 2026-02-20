import { createLogger, verifyWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { McpDiscoveryService } from "../../services/mcp-discovery";

const logger = createLogger("internal-mcp-discovery-routes");

type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      agentId?: string;
      deploymentName: string;
    };
  };
};

export function createMcpDiscoveryRoutes(
  discoveryService = new McpDiscoveryService()
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  const authenticateWorker = async (
    c: any,
    next: () => Promise<void>
  ): Promise<Response | undefined> => {
    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid authorization" }, 401);
    }
    const workerToken = authHeader.substring(7);
    const tokenData = verifyWorkerToken(workerToken);
    if (!tokenData) {
      return c.json({ error: "Invalid worker token" }, 401);
    }
    c.set("worker", tokenData);
    await next();
  };

  router.get("/internal/mcp/search", authenticateWorker, async (c) => {
    const query = (c.req.query("q") || "").trim();
    if (!query) {
      return c.json({ results: [] });
    }

    const requestedLimit = parseInt(c.req.query("limit") || "5", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 5))
      : 5;

    const results = await discoveryService.search(query, limit);
    logger.info("MCP discovery search", {
      query,
      limit,
      count: results.length,
    });

    return c.json({ results, limit });
  });

  router.get("/internal/mcp/registry/:id", authenticateWorker, async (c) => {
    const id = c.req.param("id");
    const result = await discoveryService.getById(id);
    if (!result) {
      return c.json({ error: "MCP not found" }, 404);
    }
    return c.json({ mcp: result });
  });

  logger.info("Internal MCP discovery routes registered");
  return router;
}
