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
 * Decode HTML entities back to their literal characters. Slack's `chat.postMessage`
 * `text` field auto-escapes `<`, `>`, `&` and re-rendering already-escaped content
 * (e.g. text the worker streamed via the SDK that came back through history) leaves
 * `&gt;` etc. visible to the user. Use the `markdown_text` field for a Slack post
 * so Slack does not double-escape, and pre-decode to handle entities the worker
 * may have produced upstream (e.g. from MCP tool results that returned HTML).
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Strip empty markdown links `[text]()` → `text`. Some MCP tools (notably
 * deepwiki) emit citation footnotes with no URL; rendering them as links
 * leaves visible empty parens in Slack/Telegram.
 */
function stripEmptyLinks(input: string): string {
  return input.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
}

/**
 * Slack accepts up to 12,000 chars per `markdown_text` post. Keep a margin so
 * downstream emoji/mention expansion does not push us over the limit.
 */
const SLACK_MARKDOWN_CHUNK_SIZE = 11_000;

/**
 * Split text on paragraph boundaries (`\n\n`) so we never break mid-sentence,
 * mid-list, or mid-code-fence when posting multiple chunks. Long paragraphs
 * that exceed the limit on their own fall back to line boundaries, then to
 * a hard slice as last resort.
 */
function chunkOnParagraphBoundaries(
  text: string,
  maxChunkSize: number
): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  const pushOversized = (chunk: string) => {
    // Try line boundaries first, then hard slice as a last resort.
    const lines = chunk.split("\n");
    let buf = "";
    for (const line of lines) {
      if (buf.length + line.length + 1 > maxChunkSize) {
        if (buf) chunks.push(buf);
        buf = "";
        if (line.length > maxChunkSize) {
          for (let i = 0; i < line.length; i += maxChunkSize) {
            const slice = line.slice(i, i + maxChunkSize);
            if (i + maxChunkSize >= line.length) {
              buf = slice;
            } else {
              chunks.push(slice);
            }
          }
        } else {
          buf = line;
        }
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
    }
    if (buf) chunks.push(buf);
  };

  for (const para of paragraphs) {
    if (para.length > maxChunkSize) {
      flush();
      pushOversized(para);
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChunkSize) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

/**
 * Post a text body to a Slack channel/thread using `chat.postMessage` with
 * `markdown_text`, so Slack renders markdown directly and does not HTML-escape
 * `<`, `>`, `&`. Splits long bodies on paragraph boundaries to avoid hitting
 * Slack's 12,000-char per-post limit.
 *
 * Returns true if the post was handled here, false if the caller should fall
 * back to the SDK's generic `target.post()` path.
 */
async function postSlackMarkdown(
  instance: any,
  channelId: string,
  conversationId: string | undefined,
  body: string
): Promise<boolean> {
  const adapter = instance.chat?.getAdapter?.("slack");
  const slackClient = adapter?.client;
  if (!slackClient?.chat?.postMessage) return false;

  // channelId looks like "slack:C0123ABCD"; conversationId either equals it
  // (DM/channel-level) or is "slack:C0123ABCD:1700000000.123456" for a thread.
  const channel = channelId.startsWith("slack:")
    ? channelId.slice("slack:".length)
    : channelId;
  let thread_ts: string | undefined;
  if (conversationId && conversationId !== channelId) {
    const parts = conversationId.split(":");
    if (parts.length === 3 && parts[0] === "slack") {
      thread_ts = parts[2];
    }
  }

  const chunks = chunkOnParagraphBoundaries(body, SLACK_MARKDOWN_CHUNK_SIZE);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await slackClient.chat.postMessage({
      channel,
      ...(thread_ts ? { thread_ts } : {}),
      markdown_text: chunk,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
  return true;
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

    const { connectionId, instance, channelId, platform } = ctx;
    const key = `${channelId}:${payload.conversationId}`;
    const existing = this.streams.get(key);

    // For Slack we skip the SDK streaming path entirely and post a single
    // chunked `markdown_text` message at completion. The Slack streaming API
    // (`chat.appendStream`) auto-splits at fixed sizes (breaking mid-line)
    // and the regular `chat.postMessage` `text` field HTML-escapes `<`/`>`/`&`.
    // Buffer-and-post on completion gives us paragraph-aligned chunks AND
    // markdown-native rendering. See `postSlackMarkdown` above.
    if (platform === "slack") {
      if (payload.isFullReplacement && existing) {
        // Discard prior buffered content — the worker is replacing it.
        this.streams.delete(key);
      }
      let stream = this.streams.get(key);
      if (!stream) {
        // Resolve the SDK target up front so that if `postSlackMarkdown`
        // can't reach `slackClient.chat.postMessage` at completion (adapter
        // not wired, getAdapter returns undefined, etc.) we still have a
        // non-null fallback and the response doesn't silently disappear.
        const fallbackTarget = await this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          (payload.platformMetadata as any)?.responseThreadId,
          payload.platformMetadata as Record<string, unknown> | undefined
        ).catch(() => null);
        stream = {
          iterator: new AsyncPushIterator<string>(),
          streamPromise: Promise.resolve(),
          buffer: payload.delta,
          streamFailed: true, // Force completion to use the post-buffer path
          wasFullyReplaced: !!payload.isFullReplacement,
          target: fallbackTarget,
        };
        this.streams.set(key, stream);
      } else {
        stream.buffer += payload.delta;
        if (payload.isFullReplacement) stream.wasFullyReplaced = true;
      }
      return null;
    }

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

    const { connectionId, instance, channelId, platform } = ctx;
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

      // Slack-specific path: always post via `markdown_text` with paragraph
      // chunking (see handleDelta — we never opened a real stream for Slack).
      if (platform === "slack" && stream.buffer.trim()) {
        const cleaned = stripEmptyLinks(decodeHtmlEntities(stream.buffer));
        try {
          const handled = await postSlackMarkdown(
            instance,
            channelId,
            payload.conversationId,
            cleaned
          );
          if (handled) {
            logger.info(
              { connectionId, channelId, length: cleaned.length },
              "Posted Slack response via markdown_text with paragraph chunking"
            );
          } else if (stream.target) {
            // Adapter unavailable — fall back to the SDK so we still deliver.
            await stream.target.post(cleaned);
          }
        } catch (error) {
          logger.warn(
            { connectionId, error: String(error) },
            "Slack markdown_text post failed; falling back to SDK"
          );
          if (stream.target) {
            try {
              await stream.target.post(cleaned);
            } catch (fallbackError) {
              logger.warn(
                { connectionId, error: String(fallbackError) },
                "SDK fallback post also failed"
              );
            }
          }
        }
      } else if (stream.streamFailed && stream.buffer.trim() && stream.target) {
        // Non-Slack fallback: when native streaming rejected (e.g. Slack's
        // chatStream requires a recipient user/team id that the public-API
        // send path can't supply), post the accumulated buffer non-streaming
        // so the response still lands in the thread instead of being
        // silently dropped.
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
