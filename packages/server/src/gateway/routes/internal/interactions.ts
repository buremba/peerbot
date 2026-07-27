#!/usr/bin/env bun

import {
	createLogger,
	getErrorMessage,
	sanitizeSuggestionPrompts,
} from "@lobu/core";
import {
	isApprovalAttribution,
	isInteractionResourceKind,
} from "@lobu/core/contracts/interaction-envelope";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import type { InteractionService } from "../../interactions.js";
import { persistSuggestion } from "../../suggestions/persist-suggestion.js";
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
            source,
            // entity_field_change (manage_entity) carries a human-owned-field
            // diff + who proposed it; manage_agents leaves these null.
            (body.fields ?? null) as Record<string, unknown> | null,
            // Keep malformed/legacy cards non-fatal without lying to the
            // downstream contract about their discriminator values.
            isApprovalAttribution(body.attribution) ? body.attribution : null,
            isInteractionResourceKind(body.resourceKind)
              ? body.resourceKind
              : null
          );
          // The live approval card is a one-shot SSE push, and the transcript
          // doesn't carry interaction parts — so on reload the card is lost.
          // Stamp the conversation onto the durable approval event (manage_agents
          // created it WITHOUT one — the tool ctx has no conversationId; the
          // worker does) so the history endpoint can replay it. Routing-metadata
          // only; `events` is append-only for DELETE, and once the approval is
          // resolved the superseding event drops it from current_event_records.
          await getDb()`
            UPDATE events
            SET metadata = coalesce(metadata, '{}'::jsonb)
              || jsonb_build_object('conversationId', ${conversationId}::text)
            WHERE run_id = ${Number(body.runId)}
              AND interaction_type = 'approval'
              AND interaction_status = 'pending'
          `;
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
      const {
        userId,
        conversationId,
        channelId,
        teamId,
        connectionId,
        platform,
        organizationId,
        messageId,
        source,
      } = worker;

      const body = await c.req.json();
      // The authenticated worker is NOT trusted (it ingests untrusted connector
      // content). Validate/normalize server-side — never dereference an unshaped
      // `prompts` (a non-array body would crash on `.length`).
      const prompts = sanitizeSuggestionPrompts(body?.prompts);
      if (prompts.length === 0) {
        return c.json({ success: true, prompts: 0 });
      }

      // Durable state is tenant-scoped — without an organizationId the current
      // set can't be persisted, and the web path has nothing to embed on
      // `complete`. Fail rather than accept-and-drop.
      if (!organizationId) {
        logger.warn(
          `Suggestion for ${conversationId} has no organizationId — cannot persist`
        );
        return c.json(
          { success: false, error: "missing organization context" },
          400
        );
      }

      logger.info(
        `Sending suggestions to conversation ${conversationId} (${prompts.length} prompts)`
      );

      // Persisted for the web surface only. The SPA replays a conversation from
      // history on reload, so its chips must survive the turn; a chat platform
      // renders a card that stays in the channel scrollback on its own and has
      // nothing to rehydrate. Persisting for chat too would leave rows that
      // nothing ever reads or supersedes.
      if (platform === "api") {
        await persistSuggestion({
          organizationId,
          conversationId,
          prompts,
          turnMessageId: messageId,
          runId: worker.runId ?? null,
        });
      }

      // Emit the card on every platform. `postSuggestion` fans out to whichever
      // renderer owns this conversation: the interaction bridge builds a
      // Card/Actions/Button card for chat platforms — buttons carry only
      // `suggestion:<id>:<i>` (prompt text + routing live in a pending row,
      // keeping Telegram's 64-byte callback_data budget), with a numbered-text
      // fallback where cards are unsupported — and the API platform pushes it
      // to the SSE owner for the web.
      const posted = await interactionService.postSuggestion(
        userId,
        conversationId,
        channelId,
        teamId,
        connectionId,
        platform || "unknown",
        prompts,
        source
      );

      return c.json({ success: true, prompts: prompts.length, id: posted.id });
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
