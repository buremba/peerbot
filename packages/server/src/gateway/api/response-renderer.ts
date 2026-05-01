#!/usr/bin/env bun

/**
 * API Response Renderer
 * Broadcasts worker responses to SSE connections for direct API clients
 */

import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../infrastructure/queue/types.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import type { SseManager } from "../services/sse-manager.js";
import type { WatcherRunTracker } from "../watchers/run-tracker.js";
import { resolveWatcherRunsByMessageIds } from "../../watchers/run-completion.js";

const logger = createLogger("api-response-renderer");

/**
 * Response renderer for API platform
 * Broadcasts responses to SSE clients instead of external platforms
 */
export class ApiResponseRenderer implements ResponseRenderer {
  constructor(
    private readonly sseManager: SseManager,
    private readonly watcherRunTracker?: WatcherRunTracker
  ) {}

  /**
   * Handle streaming delta content
   * Broadcasts delta to SSE connections
   */
  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<string | null> {
    const sessionId =
      (payload.platformMetadata?.sessionId as string) || payload.conversationId;

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
    const sessionId =
      (payload.platformMetadata?.sessionId as string) || payload.conversationId;

    if (!sessionId) {
      logger.warn("No session ID found in payload for completion broadcast");
      return;
    }

    // Broadcast completion to SSE clients
    this.sseManager.broadcast(sessionId, "complete", {
      type: "complete",
      messageId: payload.messageId,
      processedMessageIds: payload.processedMessageIds,
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
    const sessionId =
      (payload.platformMetadata?.sessionId as string) || payload.conversationId;

    if (!sessionId) {
      logger.warn("No session ID found in payload for error broadcast");
      return;
    }

    // Broadcast error to SSE clients
    this.sseManager.broadcast(sessionId, "error", {
      type: "error",
      error: payload.error,
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    });

    logger.error(`Broadcast error to session ${sessionId}: ${payload.error}`);

    await this.resolveWatcherRunsFromPayload(payload, {
      ok: false,
      error: typeof payload.error === "string" ? payload.error : "agent error",
    });
  }

  /**
   * Resolve any watcher-run handles whose dispatched messageId matches the
   * terminal event. Checks both the immediate messageId and processedMessageIds
   * since a single turn can batch-process multiple messages.
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
    if (!this.watcherRunTracker) return;
    for (const id of ids) {
      await this.watcherRunTracker.resolve(id, result);
    }
  }

  /**
   * Handle status updates (heartbeat with elapsed time)
   * Sends status event to SSE clients
   */
  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const sessionId =
      (payload.platformMetadata?.sessionId as string) || payload.conversationId;

    if (!sessionId) {
      return;
    }

    // Broadcast status to SSE clients
    this.sseManager.broadcast(sessionId, "status", {
      type: "status",
      status: payload.statusUpdate,
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    });
  }

  /**
   * Handle ephemeral messages
   * For API platform, these are just broadcast as regular events
   */
  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    const sessionId =
      (payload.platformMetadata?.sessionId as string) || payload.conversationId;

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
