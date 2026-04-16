/**
 * Chat response bridge — handles outbound responses from workers back through Chat SDK.
 *
 * Streaming is delegated to Chat SDK: deltas are pushed into an AsyncIterable which
 * is handed to `target.post()`. The adapter owns throttling, chunking, and
 * platform-specific rendering (Telegram buffers, Slack streams, etc.), so this
 * bridge is platform-agnostic.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../infrastructure/queue";
import { extractSettingsLinkButtons } from "../platform/link-buttons";
import type { ResponseRenderer } from "../platform/response-renderer";
import type { ChatInstanceManager } from "./chat-instance-manager";

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

/**
 * Push-based async iterable: producers call `push(value)` and `close()`;
 * consumers iterate via `for await (...)`.
 */
class AsyncPushIterator<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiter: ((v: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(value: T): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const first = this.queue.shift();
          if (first !== undefined) {
            resolve({ value: first, done: false });
            return;
          }
          if (this.done) {
            resolve({ value: undefined as unknown as T, done: true });
            return;
          }
          this.waiter = resolve;
        }),
    };
  }
}

interface StreamState {
  iterator: AsyncPushIterator<string>;
  streamPromise: Promise<unknown>;
  /** Accumulated text — kept only so handleCompletion can persist it to history. */
  buffer: string;
  /** Set when the adapter's streaming API rejected. Completion posts the buffer. */
  streamFailed: boolean;
  /**
   * True once the worker has sent at least one delta with `isFullReplacement=true`.
   * A full replacement is a complete, self-contained user-facing message
   * (e.g. the worker's own "❌ Session failed: …" text). When this is set,
   * `handleError` must NOT post its fallback `"Error: …"` text, because the
   * user has already seen a formatted failure message.
   *
   * Partial-only streams (worker streamed incremental deltas and then errored)
   * leave this false so the fallback still fires and the user sees a failure
   * indicator instead of silently-truncated output.
   */
  wasFullyReplaced: boolean;
  /** The resolved Chat SDK target — reused on failure fallback without a second resolveTarget call. */
  target: any;
}

interface ResponseContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
}

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();

  constructor(private manager: ChatInstanceManager) {}

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

    return {
      connectionId,
      instance,
      channelId,
      platform: instance.connection.platform,
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

    const { connectionId, instance, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;
    const existing = this.streams.get(key);

    // Full replacement: close current stream, await delivery, then start fresh.
    // This only fires in rare error paths (see worker.ts:584).
    if (payload.isFullReplacement && existing) {
      existing.iterator.close();
      try {
        await existing.streamPromise;
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Prior stream failed during full-replacement flush"
        );
      }
      this.streams.delete(key);
    }

    let stream = payload.isFullReplacement ? undefined : existing;

    if (!stream) {
      // First delta — open a new stream
      try {
        const target = await this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          (payload.platformMetadata as any)?.responseThreadId,
          payload.platformMetadata as Record<string, unknown> | undefined
        );
        if (!target) {
          logger.warn(
            { connectionId, channelId },
            "Failed to resolve target for delta — dropping"
          );
          return null;
        }

        const iterator = new AsyncPushIterator<string>();
        iterator.push(payload.delta);
        // target.post(AsyncIterable) — the adapter owns throttling + chunking.
        const newStream: StreamState = {
          iterator,
          streamPromise: Promise.resolve(),
          buffer: payload.delta,
          streamFailed: false,
          wasFullyReplaced: !!payload.isFullReplacement,
          target,
        };
        newStream.streamPromise = Promise.resolve(
          target.post(iterator as any)
        ).catch((error) => {
          newStream.streamFailed = true;
          logger.warn(
            { connectionId, error: String(error) },
            "Adapter stream failed — will post buffered text on completion"
          );
        });
        stream = newStream;
        this.streams.set(key, stream);
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to open delta stream"
        );
        this.streams.delete(key);
      }
      return null;
    }

    // Subsequent delta — push into the live iterator
    stream.iterator.push(payload.delta);
    stream.buffer += payload.delta;
    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Adapter stream errored during completion"
        );
      }
      // Fallback: when native streaming rejected (e.g. Slack's chatStream
      // requires a recipient user/team id that the public-API send path
      // can't supply), post the accumulated buffer non-streaming so the
      // response still lands in the thread instead of being silently dropped.
      if (stream.streamFailed && stream.buffer.trim() && stream.target) {
        try {
          await stream.target.post(stream.buffer);
          logger.info(
            { connectionId, channelId },
            "Posted buffered response via non-streaming fallback"
          );
        } catch (error) {
          logger.warn(
            { connectionId, error: String(error) },
            "Non-streaming fallback post failed"
          );
        }
      }
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

    // Threaded fallback: reconstruct the adapter's full thread id and use
    // `createThread`. Mirrors interaction-bridge.resolveThread. The Chat SDK
    // has no `getThread` — calling the missing method was a silent no-op.
    const adapter = chat.getAdapter?.(platform);
    const createThread = (chat as any).createThread;
    if (adapter && typeof createThread === "function") {
      const fullThreadId = `${channelKey}:${conversationId}`;
      try {
        const currentMessage = buildCurrentMessageFromMetadata(
          fullThreadId,
          platformMetadata
        );
        const thread = await createThread.call(
          chat,
          adapter,
          fullThreadId,
          currentMessage,
          false
        );
        if (thread) return thread;
      } catch (error) {
        logger.warn(
          { platform, fullThreadId, error: String(error) },
          "createThread with composite thread id failed"
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
