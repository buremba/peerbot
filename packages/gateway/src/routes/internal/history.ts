#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { platformRegistry } from "../../platform";
import { errorResponse, getVerifiedWorker } from "../shared/helpers";
import { authenticateWorker } from "./middleware";
import type { WorkerContext } from "./types";

const logger = createLogger("history-routes");

/**
 * Create internal history routes (Hono)
 * Provides channel history to workers via MCP tool
 */
export function createHistoryRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Get channel history
   * GET /history?platform=slack&channelId=xxx&conversationId=xxx&limit=50&before=timestamp
   */
  router.get("/history", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const platform = c.req.query("platform") || worker.platform || "api";
      const channelId = c.req.query("channelId") || worker.channelId;
      const conversationId =
        c.req.query("conversationId") || worker.conversationId;
      const limitStr = c.req.query("limit") || "50";
      const before = c.req.query("before"); // ISO timestamp cursor

      const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 100);

      if (!channelId) {
        return errorResponse(c, "Missing channelId parameter", 400);
      }

      logger.info(`Fetching history for ${platform}/${channelId}`, {
        conversationId,
        limit,
        before,
      });

      const platformAdapter = platformRegistry.get(platform);
      if (platformAdapter?.getConversationHistory) {
        const response = await platformAdapter.getConversationHistory(
          channelId,
          conversationId,
          limit,
          before
        );
        return c.json(response);
      }

      return c.json({
        messages: [],
        nextCursor: null,
        hasMore: false,
      });
    } catch (error) {
      logger.error(
        `Failed to fetch history: ${error instanceof Error ? error.message : String(error)}`
      );
      return errorResponse(c, "Internal server error", 500);
    }
  });

  return router;
}
