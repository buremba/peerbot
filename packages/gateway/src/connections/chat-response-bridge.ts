/**
 * Chat response bridge — handles outbound responses from workers back through Chat SDK.
 * Covers platform-specific markdown handling and message chunking.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../infrastructure/queue";
import { extractSettingsLinkButtons } from "../platform/link-buttons";
import { chunkMessage, delay } from "../platform/renderer-utils";
import type { ResponseRenderer } from "../platform/response-renderer";
import type { ChatInstanceManager } from "./chat-instance-manager";
import { storeOutgoingHistory } from "./message-handler-bridge";

const logger = createLogger("chat-response-bridge");

function buildOutboundPayload(text: string): { markdown: string } {
  return { markdown: text };
}

function shouldBufferUntilCompletion(platform: string): boolean {
  return platform === "telegram";
}

const MESSAGE_CHUNK_SIZE = 4096;
const CHUNK_DELAY_MS = 500;

/**
 * Streaming state for progressive message editing.
 */
interface StreamState {
  buffer: string;
  sentMessage: any | null; // SentMessage from Chat SDK
  lastEditTime: number;
  editTimer?: NodeJS.Timeout;
}

const EDIT_INTERVAL_MS = 2000;

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();

  constructor(private manager: ChatInstanceManager) {}

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

    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return null;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return null;

    const channelId =
      (payload.platformMetadata as any)?.chatId ??
      (payload.platformMetadata as any)?.responseChannel ??
      payload.channelId;
    const key = `${channelId}:${payload.conversationId}`;
    const shouldBuffer = shouldBufferUntilCompletion(
      instance.connection.platform
    );

    let stream = this.streams.get(key);

    if (!stream) {
      if (shouldBuffer) {
        this.streams.set(key, {
          buffer: payload.delta,
          sentMessage: null,
          lastEditTime: Date.now(),
        });
        return null;
      }

      // First delta — send initial message
      try {
        const target = await this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          (payload.platformMetadata as any)?.responseThreadId
        );

        if (target) {
          const sentMessage = await target.post(
            buildOutboundPayload(payload.delta) as any
          );
          stream = {
            buffer: payload.delta,
            sentMessage,
            lastEditTime: Date.now(),
          };
          this.streams.set(key, stream);
        }
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to send initial delta"
        );
        // Clean up orphaned stream entry if it was set before the failure
        this.streams.delete(key);
      }
      return null;
    }

    // Append delta
    if (payload.isFullReplacement) {
      stream.buffer = payload.delta;
    } else {
      stream.buffer += payload.delta;
    }

    if (shouldBuffer) {
      return null;
    }

    // Throttle edits
    const now = Date.now();
    if (now - stream.lastEditTime >= EDIT_INTERVAL_MS) {
      await this.editStreamMessage(stream, connectionId);
    } else if (!stream.editTimer) {
      stream.editTimer = setTimeout(
        async () => {
          // Guard against race: stream may have been deleted by handleCompletion
          // between when this timer was scheduled and when it fires.
          const current = this.streams.get(key);
          if (!current) return;
          current.editTimer = undefined;
          await this.editStreamMessage(current, connectionId);
        },
        EDIT_INTERVAL_MS - (now - stream.lastEditTime)
      );
    }

    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return;

    const channelId =
      (payload.platformMetadata as any)?.chatId ??
      (payload.platformMetadata as any)?.responseChannel ??
      payload.channelId;
    const key = `${channelId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      // Clear edit timer before deleting to prevent stale timer callbacks
      if (stream.editTimer) {
        clearTimeout(stream.editTimer);
        stream.editTimer = undefined;
      }

      if (stream.buffer.trim()) {
        await this.sendFinalMessage(
          stream,
          instance,
          channelId,
          payload.conversationId,
          connectionId,
          (payload.platformMetadata as any)?.responseThreadId
        );
      }

      this.streams.delete(key);
    }

    // Gap 1: Store outgoing response in history
    if (stream?.buffer.trim()) {
      const redis = this.manager.getServices().getQueue().getRedisClient();
      await storeOutgoingHistory(redis, connectionId, channelId, stream.buffer);
    }

    // Session reset: clear Redis history and delete session file
    if ((payload.platformMetadata as any)?.sessionReset) {
      const agentId = (payload.platformMetadata as any)?.agentId;
      try {
        const redis = this.manager.getServices().getQueue().getRedisClient();
        await redis.del(`chat:history:${connectionId}:${channelId}`);
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

    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return;

    const channelId =
      (payload.platformMetadata as any)?.chatId ??
      (payload.platformMetadata as any)?.responseChannel ??
      payload.channelId;
    const key = `${channelId}:${payload.conversationId}`;

    // Clean up stream
    const stream = this.streams.get(key);
    if (stream?.editTimer) clearTimeout(stream.editTimer);
    this.streams.delete(key);

    // For known error codes, render rich UX (e.g. settings button)
    if (payload.errorCode === "NO_MODEL_CONFIGURED") {
      try {
        const connection = await this.manager.getConnection(connectionId);
        if (connection?.templateAgentId) {
          const publicUrl = this.manager.getServices().getPublicGatewayUrl();
          const baseUrl =
            publicUrl ||
            `http://localhost:${process.env.GATEWAY_PORT || "8080"}`;
          const settingsUrl = new URL(
            `/agent/${encodeURIComponent(connection.templateAgentId)}`,
            baseUrl
          );
          settingsUrl.searchParams.set("platform", connection.platform);
          settingsUrl.searchParams.set("chat", channelId);
          settingsUrl.searchParams.set("connectionId", connectionId);
          const buttonUrl = settingsUrl.toString();
          const errorText =
            "No model configured. Please add a model provider in your settings.";

          if (connection.platform === "telegram") {
            const botToken = this.manager.getConnectionConfigSecret(
              connectionId,
              "botToken"
            );
            if (botToken) {
              const isHttps = buttonUrl.startsWith("https://");
              // Telegram requires HTTPS for all inline buttons and HTML links
              const body: Record<string, unknown> = {
                chat_id: channelId,
                text: isHttps ? errorText : `${errorText}\n\n${buttonUrl}`,
              };
              if (isHttps) {
                body.reply_markup = {
                  inline_keyboard: [
                    [{ text: "Open Settings", web_app: { url: buttonUrl } }],
                  ],
                };
              }
              const tgResp = await fetch(
                `https://api.telegram.org/bot${botToken}/sendMessage`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }
              );
              if (!tgResp.ok) {
                const respBody = await tgResp.text().catch(() => "");
                logger.warn(
                  { connectionId, status: tgResp.status, body: respBody },
                  "Telegram sendMessage failed for NO_MODEL_CONFIGURED"
                );
              }
              return;
            }
          }

          // Non-Telegram: Chat SDK Card + LinkButton
          const target = await this.resolveTarget(
            instance,
            channelId,
            payload.conversationId,
            (payload.platformMetadata as any)?.responseThreadId
          );
          if (target) {
            const { Actions, Card, CardText, LinkButton } = await import(
              "chat"
            );
            await target.post({
              card: Card({
                children: [
                  CardText(errorText),
                  Actions([
                    LinkButton({ url: buttonUrl, label: "Open Settings" }),
                  ]),
                ],
              }),
              fallbackText: `${errorText}\n\nOpen Settings: ${buttonUrl}`,
            });
            return;
          }
        }
      } catch (error) {
        logger.error(
          { connectionId, error: String(error) },
          "Failed to render settings button for NO_MODEL_CONFIGURED"
        );
      }
    }

    // Fallback: plain text error via Chat SDK
    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId
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
    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return;

    // Show typing indicator
    try {
      const channelId =
        (payload.platformMetadata as any)?.chatId ?? payload.channelId;
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId
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

    const connectionId = (payload.platformMetadata as any)?.connectionId;
    if (!connectionId) return;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return;

    try {
      const channelId =
        (payload.platformMetadata as any)?.chatId ?? payload.channelId;
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        (payload.platformMetadata as any)?.responseThreadId
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

  private async editStreamMessage(
    stream: StreamState,
    connectionId: string
  ): Promise<void> {
    if (!stream.sentMessage?.edit) return;
    try {
      await stream.sentMessage.edit(buildOutboundPayload(stream.buffer) as any);
      stream.lastEditTime = Date.now();
    } catch (error) {
      logger.debug(
        { connectionId, error: String(error) },
        "Failed to edit stream message"
      );
    }
  }

  private async sendFinalMessage(
    stream: StreamState,
    instance: any,
    channelId: string,
    conversationId: string,
    connectionId: string,
    responseThreadId?: string
  ): Promise<void> {
    const shouldBuffer = shouldBufferUntilCompletion(
      instance.connection.platform
    );
    const target = await this.resolveTarget(
      instance,
      channelId,
      conversationId,
      responseThreadId
    );
    if (!target) {
      logger.warn(
        {
          connectionId,
          channelId,
          conversationId,
          platform: instance.connection.platform,
        },
        "resolveTarget returned null — response will not be delivered"
      );
      return;
    }

    logger.info(
      {
        connectionId,
        channelId,
        platform: instance.connection.platform,
        bufferLength: stream.buffer.length,
        shouldBuffer,
      },
      "sendFinalMessage: about to post"
    );

    if (stream.buffer.length <= MESSAGE_CHUNK_SIZE) {
      try {
        if (!shouldBuffer && stream.sentMessage?.edit) {
          await stream.sentMessage.edit(
            buildOutboundPayload(stream.buffer) as any
          );
        } else {
          const result = await target.post(
            buildOutboundPayload(stream.buffer) as any
          );
          logger.info(
            {
              connectionId,
              channelId,
              resultId: result?.id,
              resultThreadId: result?.threadId,
            },
            "sendFinalMessage: post succeeded"
          );
        }
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed final message send/edit"
        );
        // Retry as plain text (no markdown) so the user still sees the response
        try {
          if (!shouldBuffer && stream.sentMessage?.edit) {
            await stream.sentMessage.edit(stream.buffer);
          } else {
            await target.post(stream.buffer);
          }
          logger.info(
            { connectionId, channelId },
            "sendFinalMessage: plain-text fallback succeeded"
          );
        } catch {
          // give up
        }
      }
      return;
    }

    const chunks = chunkMessage(stream.buffer, MESSAGE_CHUNK_SIZE);
    if (chunks.length === 0) return;
    const [firstChunk, ...remainingChunks] = chunks;
    if (!firstChunk) return;

    try {
      if (!shouldBuffer && stream.sentMessage?.edit) {
        await stream.sentMessage.edit(buildOutboundPayload(firstChunk) as any);
      } else {
        await target.post(buildOutboundPayload(firstChunk) as any);
      }
    } catch (error) {
      logger.debug(
        { connectionId, error: String(error) },
        "Failed to send first final chunk"
      );
      try {
        if (!shouldBuffer && stream.sentMessage?.edit) {
          await stream.sentMessage.edit(firstChunk);
        } else {
          await target.post(firstChunk);
        }
      } catch {
        // give up on first chunk
      }
    }

    for (let i = 0; i < remainingChunks.length; i++) {
      const chunk = remainingChunks[i]!;
      try {
        await target.post(buildOutboundPayload(chunk) as any);
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Failed to send chunk"
        );
        try {
          await target.post(chunk);
        } catch {
          // give up on this chunk
        }
      }
      if (i < remainingChunks.length - 1) {
        await delay(CHUNK_DELAY_MS);
      }
    }
  }

  private async resolveTarget(
    instance: any,
    channelId: string,
    conversationId?: string,
    responseThreadId?: string
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
          const thread = await createThread.call(
            chat,
            adapter,
            responseThreadId,
            {},
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

    if (!conversationId || conversationId === channelId) {
      const channelKey = `${platform}:${channelId}`;
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
    }

    const thread =
      (await chat.getThread?.(platform, channelId, conversationId)) ?? null;
    if (!thread) {
      logger.warn(
        { platform, channelId, conversationId, hasGetThread: !!chat.getThread },
        "chat.getThread() also returned null"
      );
    }
    return thread;
  }
}
