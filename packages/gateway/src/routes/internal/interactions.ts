#!/usr/bin/env bun

import { createLogger, verifyWorkerToken } from "@peerbot/core";
import { Hono } from "hono";
import type { InteractionService } from "../../interactions";

const logger = createLogger("internal-interaction-routes");

type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      threadId: string;
      channelId: string;
      teamId: string;
    };
  };
};

/**
 * Create internal interaction routes (Hono)
 */
export function createInteractionRoutes(
  interactionService: InteractionService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // Worker authentication middleware
  const authenticateWorker = async (c: any, next: () => Promise<void>) => {
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

  /**
   * Create a blocking interaction
   * POST /internal/interactions/create
   */
  router.post(
    "/internal/interactions/create",
    authenticateWorker,
    async (c) => {
      try {
        const worker = c.get("worker");
        const { userId, threadId, channelId, teamId } = worker;
        const { interactionType, question, options, metadata } =
          await c.req.json();

        if (!interactionType) {
          return c.json({ error: "interactionType is required" }, 400);
        }

        logger.info(
          `Creating ${interactionType} interaction for thread ${threadId}`
        );

        const interaction = await interactionService.createInteraction(
          userId,
          threadId,
          channelId,
          teamId,
          {
            interactionType,
            question,
            options,
            metadata,
          }
        );

        return c.json({ id: interaction.id });
      } catch (error) {
        logger.error("Failed to create interaction:", error);
        return c.json({ error: "Failed to create interaction" }, 500);
      }
    }
  );

  /**
   * Create non-blocking suggestions
   * POST /internal/suggestions/create
   */
  router.post("/internal/suggestions/create", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const { userId, threadId, channelId, teamId } = worker;
      const { prompts } = await c.req.json();

      logger.info(
        `Sending suggestions to thread ${threadId} (${prompts.length} prompts)`
      );

      await interactionService.createSuggestion(
        userId,
        threadId,
        channelId,
        teamId,
        prompts
      );

      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to send suggestions:", error);
      return c.json({ error: "Failed to send suggestions" }, 500);
    }
  });

  logger.info("Internal interaction routes registered");
  return router;
}
