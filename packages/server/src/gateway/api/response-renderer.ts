#!/usr/bin/env bun

/**
 * API Response Renderer
 * Broadcasts worker responses to SSE connections for direct API clients
 */

import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../infrastructure/queue/types.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import type { SseManager } from "../services/sse-manager.js";
import { resolveWatcherRunsByMessageIds } from "../../watchers/run-completion.js";

const logger = createLogger("api-response-renderer");

/**
 * Response renderer for API platform
 * Broadcasts responses to SSE clients instead of external platforms
 */
export class ApiResponseRenderer implements ResponseRenderer {
  constructor(private readonly sseManager: SseManager) {}

  /**
   * The SSE session a payload broadcasts to. Clients subscribe on the
   * conversation id (GET /events keys connections by session.conversationId
   * — see routes/public/agent.ts).
   */
  private sessionIdFor(payload: ThreadResponsePayload): string | undefined {
    return payload.conversationId;
  }

  /**
   * Handle streaming delta content
   * Broadcasts delta to SSE connections
   */
  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<string | null> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for delta broadcast");
      return null;
    }

    // Broadcast delta to SSE clients
    this.sseManager.broadcast(sessionId, "output", {
      type: "delta",
      content: payload.delta,
      timestamp: payload.timestamp || Date.now(),
      messageId: payload.messageId,
    });

    logger.debug(
      `Broadcast delta to session ${sessionId}: ${payload.delta?.length || 0} chars`
    );

    return payload.messageId;
  }

  /**
   * Handle completion of response processing
   * Sends completion event to SSE clients
   */
  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for completion broadcast");
      return;
    }

    // Broadcast completion to SSE clients.
    //
    // Carry the worker's authoritative `finalText` (the full assistant reply,
    // added to the terminal row in gateway-integration.signalCompletion for
    // exactly this cross-replica reason). Streaming `output` deltas stay
    // best-effort under N>1: a delta row claimed on a non-owning pod is lost
    // (the SseManager is per-pod), so the SPA's accumulated text can be
    // truncated. The SPA repairs from `finalText` on this terminal event —
    // without it a cross-pod delta loss would leave a permanently truncated
    // message with no repair. (Empty string when nothing was streamed.)
    this.sseManager.broadcast(sessionId, "complete", {
      type: "complete",
      messageId: payload.messageId,
      processedMessageIds: payload.processedMessageIds,
      finalText: payload.finalText,
      timestamp: payload.timestamp || Date.now(),
    });

    logger.info(`Broadcast completion to session ${sessionId}`);

    await this.resolveWatcherRunsFromPayload(payload, { ok: true });
  }

  /**
   * Handle error response
   * Sends error event to SSE clients
   */
  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for error broadcast");
      return;
    }

    const errorEvent = {
      type: "error",
      error: payload.error,
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    };

    // Keep the legacy `error` event for existing consumers, but also emit a
    // non-reserved event name for browsers: native EventSource treats `error`
    // specially and may not expose server-sent event data to addEventListener.
    this.sseManager.broadcast(sessionId, "error", errorEvent);
    this.sseManager.broadcast(sessionId, "agent-error", errorEvent);

    logger.error(`Broadcast error to session ${sessionId}: ${payload.error}`);

    await this.resolveWatcherRunsFromPayload(payload, {
      ok: false,
      error: typeof payload.error === "string" ? payload.error : "agent error",
    });
  }

  /**
   * Resolve any watcher runs whose dispatched messageId matches the terminal
   * event. Checks both the immediate messageId and processedMessageIds since
   * a single turn can batch-process multiple messages. Durable and replica-
   * safe: keyed on runs.dispatched_message_id, idempotent via the active-
   * status guard, so it's correct on whichever replica claims the row.
   */
  private async resolveWatcherRunsFromPayload(
    payload: ThreadResponsePayload,
    result: { ok: true } | { ok: false; error: string }
  ): Promise<void> {
    const ids = new Set<string>();
    if (payload.messageId) ids.add(payload.messageId);
    for (const id of payload.processedMessageIds ?? []) {
      if (id) ids.add(id);
    }
    try {
      await resolveWatcherRunsByMessageIds(ids, result);
    } catch (error) {
      logger.error("Failed to resolve watcher runs from terminal API payload", {
        error,
      });
    }
  }

  /**
   * Handle status updates (heartbeat with elapsed time)
   * Sends status event to SSE clients
   */
  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      return;
    }

    // Broadcast status to SSE clients. `statusUpdate` is an object
    // ({ elapsedSeconds, state }); the SPA's SSE consumer expects `status` to be
    // a plain string and renders it verbatim (italicized). Sending the object
    // here makes the client coerce it via String(...) → "[object Object]".
    // Send the human-readable `state` ("is running", "is scheduling", …).
    this.sseManager.broadcast(sessionId, "status", {
      type: "status",
      status: payload.statusUpdate?.state ?? "Working",
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    });
  }

  /**
   * Handle ephemeral messages
   * For API platform, these are just broadcast as regular events
   */
  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      return;
    }

    // Broadcast ephemeral content to SSE clients
    this.sseManager.broadcast(sessionId, "ephemeral", {
      type: "ephemeral",
      content: payload.content,
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    });
  }

  /**
   * Stop stream for conversation - no-op for API platform
   * SSE connections handle their own lifecycle
   */
  async stopStreamForConversation(
    _userId: string,
    _conversationId: string
  ): Promise<void> {
    // No-op - SSE connections manage their own lifecycle
  }
}
