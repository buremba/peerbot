/**
 * Telegram response renderer.
 * Handles edit-based streaming: sends a message on first delta,
 * then edits it in-place as content arrives.
 */

import { createLogger, extractTraceId } from "@lobu/core";
import type { Bot } from "grammy";
import type { ThreadResponsePayload } from "../infrastructure/queue";
import type { ResponseRenderer } from "../platform/response-renderer";
import type { TelegramConfig } from "./config";
import { convertMarkdownToTelegramHtml } from "./converters/markdown";

const logger = createLogger("telegram-response-renderer");

// Minimum interval between edits to avoid Telegram rate limits (429)
const EDIT_INTERVAL_MS = 2000;

/**
 * Callback type for storing outgoing messages in conversation history.
 */
export type StoreOutgoingMessageCallback = (
  chatKey: string,
  text: string
) => void;

/**
 * Active stream state for a response being rendered.
 */
interface StreamState {
  chatId: number;
  userId: string;
  messageId: number;
  buffer: string;
  lastEditTime: number;
  editTimer?: NodeJS.Timeout;
}

/**
 * Telegram response renderer implementation.
 * Uses message editing for progressive streaming.
 */
export class TelegramResponseRenderer implements ResponseRenderer {
  private streams = new Map<string, StreamState>();
  private storeOutgoingCallback?: StoreOutgoingMessageCallback;

  constructor(
    private bot: Bot,
    private config: TelegramConfig
  ) {}

  /**
   * Set callback for storing outgoing messages in conversation history.
   */
  setStoreOutgoingCallback(callback: StoreOutgoingMessageCallback): void {
    this.storeOutgoingCallback = callback;
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<string | null> {
    if (payload.delta === undefined) {
      return null;
    }

    const traceId = extractTraceId(payload);
    const chatId = this.getChatId(payload);
    const key = `${chatId}:${payload.conversationId}`;

    let stream = this.streams.get(key);

    if (!stream) {
      // First delta - send initial message
      const initialText = payload.delta || "...";
      try {
        const html = convertMarkdownToTelegramHtml(initialText);
        const sent = await this.bot.api.sendMessage(chatId, html, {
          parse_mode: "HTML",
        });
        stream = {
          chatId,
          userId: payload.userId,
          messageId: sent.message_id,
          buffer: initialText === "..." ? "" : initialText,
          lastEditTime: Date.now(),
        };
        this.streams.set(key, stream);
        logger.info(
          { traceId, chatId, messageId: sent.message_id },
          "Sent initial streaming message"
        );
        return String(sent.message_id);
      } catch (err) {
        logger.error(
          { traceId, error: String(err), chatId },
          "Failed to send initial message"
        );
        // Fall back to sending without parse_mode
        try {
          const sent = await this.bot.api.sendMessage(chatId, initialText);
          stream = {
            chatId,
            userId: payload.userId,
            messageId: sent.message_id,
            buffer: initialText === "..." ? "" : initialText,
            lastEditTime: Date.now(),
          };
          this.streams.set(key, stream);
          return String(sent.message_id);
        } catch (err2) {
          logger.error(
            { traceId, error: String(err2), chatId },
            "Failed to send initial message (fallback)"
          );
          return null;
        }
      }
    }

    // Subsequent delta - buffer and edit
    if (payload.isFullReplacement) {
      stream.buffer = payload.delta;
    } else {
      stream.buffer += payload.delta;
    }

    // Throttle edits
    const timeSinceLastEdit = Date.now() - stream.lastEditTime;
    if (timeSinceLastEdit >= EDIT_INTERVAL_MS) {
      await this.editMessage(stream, traceId);
    } else if (!stream.editTimer) {
      // Schedule an edit
      stream.editTimer = setTimeout(async () => {
        stream!.editTimer = undefined;
        await this.editMessage(stream!, traceId);
      }, EDIT_INTERVAL_MS - timeSinceLastEdit);
    }

    return null;
  }

  /**
   * Edit the streaming message with current buffer content.
   */
  private async editMessage(
    stream: StreamState,
    traceId?: string
  ): Promise<void> {
    if (!stream.buffer.trim()) return;

    // Telegram message length includes HTML tags when using parse_mode.
    // Once the message grows beyond the platform limit, stop trying to edit
    // (we'll send chunked plain-text messages in handleCompletion()).
    const htmlLength = convertMarkdownToTelegramHtml(stream.buffer).length;
    if (htmlLength > this.config.messageChunkSize) {
      stream.lastEditTime = Date.now();
      return;
    }

    try {
      const html = convertMarkdownToTelegramHtml(stream.buffer);
      await this.bot.api.editMessageText(
        stream.chatId,
        stream.messageId,
        html,
        { parse_mode: "HTML" }
      );
      stream.lastEditTime = Date.now();
    } catch (err) {
      const errStr = String(err);
      // Ignore "message is not modified" errors
      if (errStr.includes("message is not modified")) return;
      // On parse error, try without HTML
      if (errStr.includes("can't parse entities")) {
        try {
          await this.bot.api.editMessageText(
            stream.chatId,
            stream.messageId,
            stream.buffer
          );
          stream.lastEditTime = Date.now();
        } catch {
          // Silently ignore fallback failures
        }
        return;
      }
      logger.error(
        { traceId, error: errStr, chatId: stream.chatId },
        "Failed to edit message"
      );
    }
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const traceId = extractTraceId(payload);
    const chatId = this.getChatId(payload);
    const key = `${chatId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      // Clear any pending edit timer
      if (stream.editTimer) {
        clearTimeout(stream.editTimer);
      }

      // Final edit with complete content
      if (stream.buffer.trim()) {
        await this.sendFinalMessage(stream, traceId);
      }

      // Store in conversation history
      if (this.storeOutgoingCallback && stream.buffer.trim()) {
        this.storeOutgoingCallback(String(chatId), stream.buffer);
      }

      this.streams.delete(key);
      logger.info(
        { traceId, chatId, conversationId: payload.conversationId },
        "Sent final response"
      );
    }
  }

  /**
   * Send the final message, chunking if necessary.
   */
  private async sendFinalMessage(
    stream: StreamState,
    traceId?: string
  ): Promise<void> {
    const html = convertMarkdownToTelegramHtml(stream.buffer);

    if (html.length <= this.config.messageChunkSize) {
      // Single chunk - edit existing message
      try {
        await this.bot.api.editMessageText(
          stream.chatId,
          stream.messageId,
          html,
          {
            parse_mode: "HTML",
          }
        );
      } catch (err) {
        const errStr = String(err);
        if (!errStr.includes("message is not modified")) {
          // Try without HTML
          try {
            await this.bot.api.editMessageText(
              stream.chatId,
              stream.messageId,
              stream.buffer
            );
          } catch {
            logger.error({ traceId, error: errStr }, "Failed final edit");
          }
        }
      }
      return;
    }

    // Message too long for a single HTML message. Chunk the plain text and
    // convert each chunk individually so links/formatting still render.
    const plainChunks = this.chunkMessage(
      stream.buffer,
      this.config.messageChunkSize
    );
    if (plainChunks.length === 0) {
      return;
    }

    try {
      const firstHtml = convertMarkdownToTelegramHtml(plainChunks[0]!);
      await this.bot.api.editMessageText(
        stream.chatId,
        stream.messageId,
        firstHtml,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      // Fall back to plain text if HTML fails
      try {
        await this.bot.api.editMessageText(
          stream.chatId,
          stream.messageId,
          plainChunks[0]!
        );
      } catch {
        logger.debug(
          { traceId, error: String(err), chatId: stream.chatId },
          "Failed to edit first chunk"
        );
      }
    }

    for (let i = 1; i < plainChunks.length; i++) {
      try {
        const chunkHtml = convertMarkdownToTelegramHtml(plainChunks[i]!);
        await this.bot.api.sendMessage(stream.chatId, chunkHtml, {
          parse_mode: "HTML",
        });
      } catch {
        // Fall back to plain text
        try {
          await this.bot.api.sendMessage(stream.chatId, plainChunks[i]!);
        } catch (err) {
          logger.debug(
            { traceId, error: String(err), chatId: stream.chatId },
            "Failed to send chunk"
          );
        }
      }
      if (i < plainChunks.length - 1) {
        await this.delay(500);
      }
    }
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    const traceId = extractTraceId(payload);
    const chatId = this.getChatId(payload);
    const key = `${chatId}:${payload.conversationId}`;

    // Clean up stream state
    const stream = this.streams.get(key);
    if (stream?.editTimer) {
      clearTimeout(stream.editTimer);
    }
    this.streams.delete(key);

    const errorMessage = `Error: ${payload.error}`;

    try {
      await this.bot.api.sendMessage(chatId, errorMessage);
    } catch (err) {
      logger.error(
        { traceId, error: String(err), chatId },
        "Failed to send error message"
      );
    }

    logger.error(
      {
        traceId,
        chatId,
        conversationId: payload.conversationId,
        error: payload.error,
      },
      "Sent error response"
    );
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.statusUpdate) return;

    const chatId = this.getChatId(payload);

    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch (err) {
      logger.debug(
        { error: String(err), chatId },
        "Failed to send typing action"
      );
    }
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    const chatId = this.getChatId(payload);

    // Try to parse as JSON (Slack blocks format)
    try {
      const parsed = JSON.parse(payload.content);
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        const textParts: string[] = [];
        for (const block of parsed.blocks) {
          if (block.type === "section" && block.text?.text) {
            textParts.push(block.text.text);
          }
        }
        if (textParts.length > 0) {
          const message = textParts.join("\n\n");
          await this.bot.api.sendMessage(chatId, message);
          return;
        }
      }
    } catch {
      // Not JSON - send as plain text
    }

    await this.bot.api.sendMessage(chatId, payload.content);
  }

  /**
   * Get chat ID from payload metadata.
   */
  private getChatId(payload: ThreadResponsePayload): number {
    const platformMetadata = (payload as any).platformMetadata || {};
    const chatId =
      platformMetadata.chatId ||
      platformMetadata.responseChannel ||
      payload.channelId;
    return typeof chatId === "number" ? chatId : Number(chatId);
  }

  /**
   * Chunk message into smaller parts.
   */
  private chunkMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let breakPoint = maxLength;

      const newlineIndex = remaining.lastIndexOf("\n", maxLength);
      if (newlineIndex > maxLength * 0.5) {
        breakPoint = newlineIndex + 1;
      } else {
        const spaceIndex = remaining.lastIndexOf(" ", maxLength);
        if (spaceIndex > maxLength * 0.5) {
          breakPoint = spaceIndex + 1;
        }
      }

      chunks.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks.filter((c) => c.length > 0);
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Cleanup resources (clear timers).
   */
  cleanup(): void {
    for (const stream of this.streams.values()) {
      if (stream.editTimer) {
        clearTimeout(stream.editTimer);
      }
    }
    this.streams.clear();
  }
}
