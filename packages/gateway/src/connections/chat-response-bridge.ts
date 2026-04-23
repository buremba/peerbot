/**
 * Chat response bridge — handles outbound responses from workers back through Chat SDK.
 *
 * Streaming is delegated to Chat SDK: deltas are pushed into an AsyncIterable which
 * is handed to `target.post()`. The adapter owns throttling, chunking, and
 * platform-specific rendering (Telegram buffers, Slack streams, etc.), so this
 * bridge is platform-agnostic.
 *
 * Platform quirks (e.g. Slack posting a single chunked `markdown_text` at
 * completion) live in `./platform-strategies`; the bridge picks one per
 * payload and delegates delta/completion shape to it.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../infrastructure/queue";
import { extractSettingsLinkButtons } from "../platform/link-buttons";
import type { ResponseRenderer } from "../platform/response-renderer";
import type { ChatInstanceManager } from "./chat-instance-manager";
import {
  getResponseStrategy,
  type PlatformResponseStrategy,
  type StreamState,
} from "./platform-strategies";

const logger = createLogger("chat-response-bridge");

/**
 * Construct a minimal Chat SDK `Message`-shaped object from the inbound
 * sender carried on `platformMetadata`. We only need enough to keep the SDK's
 * streaming code path happy — it reads `_currentMessage.author.userId` and
 * `_currentMessage.raw.team_id`/`raw.team` for ephemeral/DM fallback hints.
 * Passing `{}` crashes the SDK; passing `undefined` silently disables the
 * recipient hint; a proper Message preserves it.
 */
function buildCurrentMessageFromMetadata(
  threadId: string,
  platformMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const senderId = platformMetadata?.senderId as string | undefined;
  if (!senderId) return undefined;
  const senderUsername = platformMetadata?.senderUsername as string | undefined;
  const senderDisplayName = platformMetadata?.senderDisplayName as
    | string
    | undefined;
  const teamId = platformMetadata?.teamId as string | undefined;
  return {
    threadId,
    text: "",
    author: {
      userId: senderId,
      userName: senderUsername,
      fullName: senderDisplayName,
    },
    raw: teamId ? { team_id: teamId, team: teamId } : {},
  };
}

interface ResponseContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
  strategy: PlatformResponseStrategy;
}

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();

  constructor(private manager: ChatInstanceManager) {}

  // TODO(#254): output-stage guardrail hook. Before emitting a delta to the
  // platform strategy, call runGuardrails("output", registry, settings.guardrails,
  // { text: payload.delta, ... }). On trip: redact or replace the delta per
  // guardrail policy. Wiring deferred to the PR that registers the first
  // real output guardrail (#253 secret/PII scan).
  private extractResponseContext(
    payload: ThreadResponsePayload
  ): ResponseContext | null {
    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return null;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return null;

    const channelId =
      (payload.platformMetadata as any)?.chatId ??
      (payload.platformMetadata as any)?.responseChannel ??
      payload.channelId;

    const platform = instance.connection.platform;

    return {
      connectionId,
      instance,
      channelId,
      platform,
      strategy: getResponseStrategy(platform),
    };
  }

  /**
   * Check if this payload belongs to a Chat SDK connection.
   * Returns false if the connection is not managed — the caller should fall through to legacy.
   */
  canHandle(data: ThreadResponsePayload): boolean {
    const connectionId = (data.platformMetadata as any)?.connectionId;
    return !!connectionId && this.manager.has(connectionId);
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null> {
    void sessionKey;
    if (payload.delta === undefined) return null;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return null;

    const { strategy, instance, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;
    const existing = this.streams.get(key);

    // Full replacement: ask the strategy to dispose the prior stream (the
    // default strategy closes the live iterator and awaits its delivery;
    // Slack is a no-op since no real stream was opened). Treat the delta
    // as the start of a fresh stream below.
    let current = existing;
    if (payload.isFullReplacement && existing) {
      await strategy.disposeOnFullReplacement(existing);
      this.streams.delete(key);
      current = undefined;
    }

    const next = await strategy.handleDelta({
      ctx,
      payload,
      existing: current,
      resolveTarget: () =>
        this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          (payload.platformMetadata as any)?.responseThreadId,
          payload.platformMetadata as Record<string, unknown> | undefined
        ),
    });

    if (next) {
      this.streams.set(key, next);
    } else {
      this.streams.delete(key);
    }
    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, strategy, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      // Close the iterator and drain the in-flight post regardless of
      // strategy — Slack's iterator is already closed (no-op), default's
      // needs explicit close+await before final delivery steps run.
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Adapter stream errored during completion"
        );
      }

      await strategy.handleCompletion({ ctx, payload, stream });
      this.streams.delete(key);
    }

    const conversationState =
      this.manager.getInstance(connectionId)?.conversationState;

    // Gap 1: Store outgoing response in history
    if (stream?.buffer.trim() && conversationState) {
      await conversationState.appendHistory(connectionId, channelId, {
        role: "assistant",
        content: stream.buffer,
        timestamp: Date.now(),
      });
    }

    // Session reset: clear history and delete session file
    if ((payload.platformMetadata as any)?.sessionReset) {
      const agentId = (payload.platformMetadata as any)?.agentId;
      try {
        await conversationState?.clearHistory(connectionId, channelId);
        logger.info(
          { connectionId, channelId },
          "Cleared chat history for session reset"
        );
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "Failed to clear chat history on session reset"
        );
      }
      if (agentId) {
        try {
          const sessionPath = resolve(
            "workspaces",
            agentId,
            ".openclaw",
            "session.jsonl"
          );
          await unlink(sessionPath);
          logger.info(
            { agentId, sessionPath },
            "Deleted session file for session reset"
          );
        } catch (error) {
          // File may not exist — that's fine
          logger.debug(
            { agentId, error: String(error) },
            "No session file to delete on reset"
          );
        }
      }
    }

    logger.info(
      {
        connectionId,
        channelId,
        conversationId: payload.conversationId,
      },
      "Response completed via Chat SDK bridge"
    );
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, instance, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // Clean up stream — close iterator so the adapter call resolves.
    // Capture whether the worker already delivered a complete, self-contained
    // user-facing message (via `sendStreamDelta(..., isFullReplacement=true)`).
    // When it did, we must NOT post the fallback raw "Error: …" because the
    // user already saw a formatted failure message like "❌ Session failed: …".
    //
    // For partial streams that errored mid-way (`isFullReplacement` never set),
    // the fallback still fires so the user sees a failure indicator instead of
    // silently-truncated output.
    const stream = this.streams.get(key);
    const alreadyDeliveredCompleteMessage = !!stream?.wasFullyReplaced;
    if (stream) {
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch {
        // swallow — we're already in error path
      }
      this.streams.delete(key);
    }

    if (alreadyDeliveredCompleteMessage) {
      logger.debug(
        { connectionId, channelId },
        "Skipping fallback error text — worker already delivered a complete user-facing message"
      );
      return;
    }

    // For known error codes, render user-facing guidance without sending users
    // to the retired end-user settings UI.
    if (payload.errorCode === "NO_MODEL_CONFIGURED") {
      payload.error =
        "No model configured. Provider setup is not available in the end-user chat flow yet. Ask an admin to connect a provider for the base agent.";
    }

    // Fallback: plain text error via Chat SDK
    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId,
        payload.platformMetadata as Record<string, unknown> | undefined
      );
      if (target) {
        await target.post(`Error: ${payload.error}`);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Failed to send error message"
      );
    }
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { instance, channelId } = ctx;

    // Show typing indicator
    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId,
        payload.platformMetadata as Record<string, unknown> | undefined
      );
      if (target) {
        await target.startTyping?.("Processing...");
      }
    } catch {
      // best effort
    }
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, instance, channelId } = ctx;

    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId,
        payload.platformMetadata as Record<string, unknown> | undefined
      );
      if (target) {
        const { processedContent, linkButtons } = extractSettingsLinkButtons(
          payload.content
        );

        if (linkButtons.length > 0) {
          try {
            const { Actions, Card, CardText, LinkButton } = await import(
              "chat"
            );
            const card = Card({
              children: [
                CardText(processedContent),
                Actions(
                  linkButtons.map((button) =>
                    LinkButton({ url: button.url, label: button.text })
                  )
                ),
              ],
            });
            await target.post({
              card,
              fallbackText: `${processedContent}\n\n${linkButtons.map((button) => `${button.text}: ${button.url}`).join("\n")}`,
            });
            return;
          } catch (error) {
            logger.warn(
              { connectionId, error: String(error) },
              "Failed to render ephemeral settings button"
            );
            const fallbackText = `${processedContent}\n\n${linkButtons.map((button) => `${button.text}: ${button.url}`).join("\n")}`;
            await target.post(fallbackText.trim());
            return;
          }
        }

        await target.post(processedContent);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Failed to send ephemeral message"
      );
    }
  }

  // --- Private ---

  private async resolveTarget(
    instance: any,
    channelId: string,
    conversationId?: string,
    responseThreadId?: string,
    platformMetadata?: Record<string, unknown>
  ): Promise<any | null> {
    const platform = instance.connection.platform;
    const chat = instance.chat;

    // If we have a full thread ID (e.g. telegram:{chatId}:{topicId}), use
    // createThread so the response lands in the correct forum topic.
    if (responseThreadId) {
      const adapter = chat.getAdapter?.(platform);
      const createThread = (chat as any).createThread;
      if (adapter && typeof createThread === "function") {
        try {
          // Build the initialMessage from the inbound sender so the Chat SDK
          // can populate `_currentMessage.author` for `handleStream` (it reads
          // `.author.userId` unconditionally — passing `{}` crashes there).
          const currentMessage = buildCurrentMessageFromMetadata(
            responseThreadId,
            platformMetadata
          );
          const thread = await createThread.call(
            chat,
            adapter,
            responseThreadId,
            currentMessage,
            false
          );
          if (thread) return thread;
        } catch (error) {
          logger.debug(
            { platform, responseThreadId, error: String(error) },
            "createThread from responseThreadId failed, falling back"
          );
        }
      }
    }

    const channelKey = `${platform}:${channelId}`;

    if (!conversationId || conversationId === channelId) {
      const channel = chat.channel?.(channelKey);
      if (channel) {
        return channel;
      }
      logger.warn(
        {
          platform,
          channelId,
          channelKey,
          conversationId,
          hasChannelFn: !!chat.channel,
        },
        "chat.channel() returned null for DM"
      );
      return null;
    }

    // Threaded fallback: `conversationId` is the Chat SDK's canonical
    // `thread.id` (e.g. `slack:{channel}:{parent_thread_ts}`) — pass it
    // straight to `createThread`.
    const adapter = chat.getAdapter?.(platform);
    const createThread = (chat as any).createThread;
    if (adapter && typeof createThread === "function") {
      try {
        const currentMessage = buildCurrentMessageFromMetadata(
          conversationId,
          platformMetadata
        );
        const thread = await createThread.call(
          chat,
          adapter,
          conversationId,
          currentMessage,
          false
        );
        if (thread) return thread;
      } catch (error) {
        logger.warn(
          { platform, conversationId, error: String(error) },
          "createThread with conversationId failed"
        );
      }
    }

    // Last-resort channel-level fallback so the response still lands somewhere
    // instead of silently disappearing.
    const channel = chat.channel?.(channelKey);
    if (!channel) {
      logger.warn(
        { platform, channelId, channelKey, conversationId },
        "resolveTarget: unable to resolve thread or channel"
      );
    }
    return channel ?? null;
  }
}
