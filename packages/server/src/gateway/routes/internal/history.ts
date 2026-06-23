#!/usr/bin/env bun

import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { Hono } from "hono";
import { platformRegistry } from "../../platform.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

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
      // SECURITY: the channel/conversation/platform a worker may read history
      // for is fixed by its verified token, NOT by request input. Earlier this
      // route let query params override the token (`query || token`), so a
      // worker could pass `?platform=slack&channelId=<other channel>` and read
      // any channel's history on any platform — cross-channel/cross-tenant
      // disclosure. Only pagination (`limit`, `before`) is caller-controlled,
      // and both are scoped within the already-authorized channel.
      const platform = worker.platform || "api";
      const channelId = worker.channelId;
      const conversationId = worker.conversationId;
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
        `Failed to fetch history: ${getErrorMessage(error)}`
      );
      return errorResponse(c, "Internal server error", 500);
    }
  });

  return router;
}
