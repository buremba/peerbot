#!/usr/bin/env bun

import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { Hono } from "hono";
import type { InteractionService } from "../../interactions.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

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
          // Headless run origin (watcher-run/scheduled-job/connector-repair/
          // internal). Threaded onto the card so the API platform can exempt
          // it from the SSE-owner gate — a headless turn has no browser SSE on
          // any pod, so an owner-gated card would dead-letter.
          source,
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
            typeof body.body === "string" ? body.body : undefined,
            source
          );
          return c.json({ id: posted.id, status: "posted" });
        }

        // Durable approval card (runs/events-backed; today the builder agent's
        // manage_agents write gate). Routed to the API platform's
        // tool:durable-approval-card subscription, which enqueues it onto the
        // SAME owner-gated thread_response queue the other cards use.
        if (interactionType === "tool_approval") {
          const posted = await interactionService.postDurableApprovalCard(
            userId,
            conversationId,
            channelId,
            teamId,
            connectionId,
            platform || "unknown",
            Number(body.runId),
            typeof body.action === "string" ? body.action : "change",
            (body.proposal ?? null) as Record<string, unknown> | null,
            (body.current ?? null) as Record<string, unknown> | null,
            source
          );
          return c.json({ id: posted.id, status: "posted" });
        }

        const posted = await interactionService.postQuestion(
          userId,
          conversationId,
          channelId,
          teamId,
          connectionId,
          platform || "unknown",
          body.question,
          body.options || [],
          source
        );

        return c.json({ id: posted.id, status: "posted" });
      } catch (error) {
        // Serialize the message + stack explicitly. The console logger
        // JSON.stringifies a positional Error arg to `{}` (Error's own
        // enumerable props are empty), which is exactly what hid the
        // connectionId 500 in #1274. Use the codebase's `{ error: <message> }`
        // convention so the real cause (e.g. assertRoutableInteraction's
        // "connectionId is required") is visible.
        logger.error("Failed to post question", {
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
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
      logger.error("Failed to send suggestions", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to send suggestions", 500);
    }
  });

  logger.debug("Internal interaction routes registered");
  return router;
}
