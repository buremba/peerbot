#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { InteractionService } from "../../interactions";
import { errorResponse, getVerifiedWorker } from "../shared/helpers";
import { authenticateWorker } from "./middleware";
import type { WorkerContext } from "./types";

const logger = createLogger("internal-interaction-routes");

/**
 * Create internal interaction routes (Hono)
 */
export function createInteractionRoutes(
  interactionService: InteractionService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Post a question with button options (non-blocking)
   * POST /internal/interactions/create
   */
  router.post(
    "/internal/interactions/create",
    authenticateWorker,
    async (c) => {
      try {
        const worker = getVerifiedWorker(c);
        const {
          userId,
          conversationId,
          channelId,
          teamId,
          connectionId,
          platform,
        } = worker;
        const body = await c.req.json();
        const interactionType =
          typeof body?.interactionType === "string"
            ? body.interactionType
            : "question";

        logger.info(
          `Posting ${interactionType} for conversation ${conversationId}`
        );

        if (interactionType === "link_button") {
          const posted = await interactionService.postLinkButton(
            userId,
            conversationId,
            channelId,
            teamId,
            connectionId,
            platform || "unknown",
            body.url,
            body.label,
            body.linkType || "oauth",
            typeof body.body === "string" ? body.body : undefined
          );
          return c.json({ id: posted.id, status: "posted" });
        }

        const posted = await interactionService.postQuestion(
          userId,
          conversationId,
          channelId,
          teamId,
          connectionId,
          body.question,
          body.options || []
        );

        return c.json({ id: posted.id, status: "posted" });
      } catch (error) {
        logger.error("Failed to post question:", error);
        return errorResponse(c, "Failed to post question", 500);
      }
    }
  );

  /**
   * Create non-blocking suggestions
   * POST /internal/suggestions/create
   */
  router.post("/internal/suggestions/create", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const { userId, conversationId, channelId, teamId } = worker;
      const { prompts } = await c.req.json();

      logger.info(
        `Sending suggestions to conversation ${conversationId} (${prompts.length} prompts)`
      );

      await interactionService.createSuggestion(
        userId,
        conversationId,
        channelId,
        teamId,
        prompts
      );

      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to send suggestions:", error);
      return errorResponse(c, "Failed to send suggestions", 500);
    }
  });

  logger.debug("Internal interaction routes registered");
  return router;
}
