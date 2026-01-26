/**
 * WhatsApp response renderer.
 * Handles buffered responses with progressive chunks,
 * plain text formatting, and typing indicators.
 */

import { createLogger, extractTraceId } from "@peerbot/core";
import type { ThreadResponsePayload } from "../infrastructure/queue";
import type { ResponseRenderer } from "../platform/response-renderer";
import type { WhatsAppConfig } from "./config";
import type { BaileysClient } from "./connection/baileys-client";
import { convertMarkdownToWhatsApp } from "./converters/markdown";

const logger = createLogger("whatsapp-response-renderer");

// Progressive chunk settings
const CHUNK_INTERVAL_MS = 30000; // Send chunk every 30 seconds
const MIN_CHUNK_SIZE = 500; // Minimum characters before sending a chunk

/**
 * Callback type for storing outgoing messages in conversation history.
 */
export type StoreOutgoingMessageCallback = (
  chatJid: string,
  text: string
) => void;

/**
 * WhatsApp response renderer implementation.
 * Buffers streaming content and sends progressive chunks every 30 seconds.
 */
export class WhatsAppResponseRenderer implements ResponseRenderer {
  private responseBuffer = new Map<string, string>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private lastSendTime = new Map<string, number>();
  private chunkTimers = new Map<string, NodeJS.Timeout>();
  private storeOutgoingCallback?: StoreOutgoingMessageCallback;

  constructor(
    private client: BaileysClient,
    private config: WhatsAppConfig
  ) {}

  /**
   * Set callback for storing outgoing messages in conversation history.
   */
  setStoreOutgoingCallback(callback: StoreOutgoingMessageCallback): void {
    this.storeOutgoingCallback = callback;
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string // Not used for WhatsApp
  ): Promise<string | null> {
    if (payload.delta === undefined) {
      return null;
    }

    // Extract traceId for observability
    const traceId = extractTraceId(payload);

    const chatJid = this.getChatJid(payload);
    const key = `${chatJid}:${payload.threadId}`;

    if (payload.isFullReplacement) {
      this.responseBuffer.set(key, payload.delta);
    } else {
      const existing = this.responseBuffer.get(key) || "";
      this.responseBuffer.set(key, existing + payload.delta);
    }

    // Initialize last send time if not set
    if (!this.lastSendTime.has(key)) {
      this.lastSendTime.set(key, Date.now());
    }

    // Check if we should send a progressive chunk
    const buffer = this.responseBuffer.get(key) || "";
    const timeSinceLastSend = Date.now() - (this.lastSendTime.get(key) || 0);

    if (
      buffer.length >= MIN_CHUNK_SIZE &&
      timeSinceLastSend >= CHUNK_INTERVAL_MS
    ) {
      await this.sendProgressiveChunk(chatJid, key, buffer, traceId);
    } else {
      // Keep showing typing while buffering
      await this.client.sendTyping(chatJid, this.config.typingTimeout);

      // Set up a timer to send chunk after 30s if still buffering
      this.scheduleChunkTimer(chatJid, key, traceId);
    }

    return null; // WhatsApp doesn't return message IDs during streaming
  }

  /**
   * Send a progressive chunk and reset buffer.
   */
  private async sendProgressiveChunk(
    chatJid: string,
    key: string,
    content: string,
    traceId?: string
  ): Promise<void> {
    // Clear any pending chunk timer
    this.clearChunkTimer(key);

    // Add continuation indicator
    const chunkText = `${content}\n\n_...continuing..._`;

    try {
      await this.sendMessage(chatJid, chunkText);
      logger.info(
        { traceId, chatJid, chunkLength: content.length },
        "Sent progressive chunk"
      );
    } catch (err) {
      logger.error(
        { traceId, error: String(err), chatJid },
        "Failed to send progressive chunk"
      );
    }

    // Clear buffer and update last send time
    this.responseBuffer.set(key, "");
    this.lastSendTime.set(key, Date.now());
  }

  /**
   * Schedule a timer to send chunk after interval.
   */
  private scheduleChunkTimer(
    chatJid: string,
    key: string,
    traceId?: string
  ): void {
    // Don't schedule if already scheduled
    if (this.chunkTimers.has(key)) return;

    const timer = setTimeout(async () => {
      const buffer = this.responseBuffer.get(key) || "";
      if (buffer.length >= MIN_CHUNK_SIZE) {
        await this.sendProgressiveChunk(chatJid, key, buffer, traceId);
      }
      this.chunkTimers.delete(key);
    }, CHUNK_INTERVAL_MS);

    this.chunkTimers.set(key, timer);
  }

  /**
   * Clear chunk timer for a key.
   */
  private clearChunkTimer(key: string): void {
    const timer = this.chunkTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.chunkTimers.delete(key);
    }
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const traceId = extractTraceId(payload);
    const chatJid = this.getChatJid(payload);
    const key = `${chatJid}:${payload.threadId}`;

    // Clear timers
    this.clearTypingTimer(chatJid);
    this.clearChunkTimer(key);

    // Send any remaining buffered content (final chunk, no "continuing" indicator)
    const buffered = this.responseBuffer.get(key);
    if (buffered?.trim()) {
      await this.sendMessage(chatJid, buffered);
      logger.info(
        { traceId, chatJid, threadId: payload.threadId },
        "Sent final response"
      );
    }

    // Cleanup all state for this response
    this.responseBuffer.delete(key);
    this.lastSendTime.delete(key);
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    const traceId = extractTraceId(payload);
    const chatJid = this.getChatJid(payload);
    const key = `${chatJid}:${payload.threadId}`;

    // Clear timers
    this.clearTypingTimer(chatJid);
    this.clearChunkTimer(key);

    // Clear all state
    this.responseBuffer.delete(key);
    this.lastSendTime.delete(key);

    // Send error message
    const errorMessage = `Error: ${payload.error}`;
    await this.sendMessage(chatJid, errorMessage);
    logger.error(
      { traceId, chatJid, threadId: payload.threadId, error: payload.error },
      "Sent error response"
    );
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.statusUpdate) return;

    const chatJid = this.getChatJid(payload);

    // Show typing indicator
    await this.client.sendTyping(chatJid, this.config.typingTimeout);

    // Refresh typing indicator periodically
    this.clearTypingTimer(chatJid);

    const timer = setTimeout(async () => {
      await this.client.sendTyping(chatJid, this.config.typingTimeout);
    }, this.config.typingTimeout - 1000);

    this.typingTimers.set(chatJid, timer);
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    const chatJid = this.getChatJid(payload);

    // Try to parse as JSON (Slack blocks format)
    try {
      const parsed = JSON.parse(payload.content);
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        // Extract text from Slack blocks, preserving formatting
        // Slack and WhatsApp use the same syntax (*bold*, _italic_)
        const textParts: string[] = [];
        for (const block of parsed.blocks) {
          if (block.type === "section" && block.text?.text) {
            textParts.push(block.text.text);
          }
        }
        if (textParts.length > 0) {
          const message = textParts.join("\n\n");
          await this.sendMessage(chatJid, message);
          return;
        }
      }
    } catch {
      // Not JSON - send as plain text
    }

    await this.sendMessage(chatJid, payload.content);
  }

  /**
   * Get chat JID from payload metadata.
   */
  private getChatJid(payload: ThreadResponsePayload): string {
    const platformMetadata = (payload as any).platformMetadata || {};
    return (
      platformMetadata.jid ||
      platformMetadata.responseChannel ||
      payload.channelId
    );
  }

  /**
   * Clear typing timer for a chat.
   */
  private clearTypingTimer(chatJid: string): void {
    if (this.typingTimers.has(chatJid)) {
      clearTimeout(this.typingTimers.get(chatJid)!);
      this.typingTimers.delete(chatJid);
    }
  }

  /**
   * Send a message, converting markdown and chunking if necessary.
   */
  private async sendMessage(chatJid: string, text: string): Promise<void> {
    // Convert markdown to WhatsApp formatting
    const formatted = convertMarkdownToWhatsApp(text);
    const chunks = this.chunkMessage(formatted, this.config.messageChunkSize);

    for (const chunk of chunks) {
      try {
        await this.client.sendMessage(chatJid, { text: chunk });

        // Small delay between chunks to maintain order
        if (chunks.length > 1) {
          await this.delay(500);
        }
      } catch (err) {
        logger.error(
          { error: String(err), chatJid, chunkLength: chunk.length },
          "Failed to send message chunk"
        );
        throw err;
      }
    }

    // Store in conversation history
    if (this.storeOutgoingCallback) {
      this.storeOutgoingCallback(chatJid, text);
    }

    logger.info(
      { chatJid, chunks: chunks.length, totalLength: text.length },
      "Message sent"
    );
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

      // Try to break at a natural point
      let breakPoint = maxLength;

      // Look for newline
      const newlineIndex = remaining.lastIndexOf("\n", maxLength);
      if (newlineIndex > maxLength * 0.5) {
        breakPoint = newlineIndex + 1;
      } else {
        // Look for space
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
    for (const timer of this.typingTimers.values()) {
      clearTimeout(timer);
    }
    this.typingTimers.clear();

    for (const timer of this.chunkTimers.values()) {
      clearTimeout(timer);
    }
    this.chunkTimers.clear();

    this.responseBuffer.clear();
    this.lastSendTime.clear();
  }
}
