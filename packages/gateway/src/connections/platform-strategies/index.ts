/**
 * Platform response strategies for the Chat SDK bridge.
 *
 * Each strategy encapsulates the platform-specific quirks of streaming text
 * responses back to the user (e.g. Slack posts at completion via
 * `markdown_text`, most other platforms stream deltas through the Chat SDK).
 *
 * `ChatResponseBridge` picks one strategy per payload based on the platform
 * field and delegates the delta/completion shape to it — no more ad-hoc
 * `if (platform === "slack")` branches in the bridge.
 */

import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../../infrastructure/queue";
import { AsyncPushIterator } from "./async-push-iterator";

const logger = createLogger("platform-response-strategies");

export interface StreamState {
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

export interface StrategyContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
}

/**
 * How the strategy wants the bridge to resolve a Chat SDK target. Passed as a
 * callback so the bridge keeps sole ownership of target resolution and we
 * don't duplicate that logic per strategy.
 */
export type ResolveTarget = () => Promise<any | null>;

export interface PlatformResponseStrategy {
  /**
   * Handle `isFullReplacement=true` when there is an existing stream.
   *
   * The default strategy must close the live iterator and await the adapter's
   * streamPromise so the in-flight post resolves before a new one opens.
   * Slack never opens a real stream, so it just discards the buffer.
   *
   * Returning means the caller should treat `existing` as disposed and pass
   * `undefined` to the subsequent `handleDelta` call.
   */
  disposeOnFullReplacement(existing: StreamState): Promise<void>;

  /**
   * Handle a delta payload.
   *
   * - If `existing` is `undefined`, the strategy opens a new stream.
   * - Otherwise it appends to the existing stream.
   *
   * Returns the next `StreamState` (or `null` if a fresh stream could not be
   * opened). The bridge keys the returned state by channel/conversation.
   */
  handleDelta(args: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null>;

  /**
   * Handle completion for a stream. Called after the bridge has closed the
   * stream's iterator and awaited the adapter's streamPromise. Responsible
   * for any platform-specific final post (e.g. Slack's `markdown_text`).
   */
  handleCompletion(args: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState;
  }): Promise<void>;
}

/**
 * Default strategy: stream deltas straight through the Chat SDK's
 * `target.post(AsyncIterable)` path. Used for Telegram and anything without
 * platform-specific buffering requirements.
 */
export class DefaultResponseStrategy implements PlatformResponseStrategy {
  async disposeOnFullReplacement(existing: StreamState): Promise<void> {
    // Close current stream and await delivery so a new one can open cleanly.
    existing.iterator.close();
    try {
      await existing.streamPromise;
    } catch (error) {
      logger.debug(
        { error: String(error) },
        "Prior stream failed during full-replacement flush"
      );
    }
  }

  async handleDelta({
    ctx,
    payload,
    existing,
    resolveTarget,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null> {
    const { connectionId, channelId } = ctx;

    if (!existing) {
      // First delta — open a new stream
      try {
        const target = await resolveTarget();
        if (!target) {
          logger.warn(
            { connectionId, channelId },
            "Failed to resolve target for delta — dropping"
          );
          return null;
        }

        const iterator = new AsyncPushIterator<string>();
        iterator.push(payload.delta as string);
        // target.post(AsyncIterable) — the adapter owns throttling + chunking.
        const newStream: StreamState = {
          iterator,
          streamPromise: Promise.resolve(),
          buffer: payload.delta as string,
          streamFailed: false,
          wasFullyReplaced: !!payload.isFullReplacement,
          target,
        };
        newStream.streamPromise = Promise.resolve(
          target.post(iterator as any)
        ).catch((error: unknown) => {
          newStream.streamFailed = true;
          logger.warn(
            { connectionId, error: String(error) },
            "Adapter stream failed — will post buffered text on completion"
          );
        });
        return newStream;
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to open delta stream"
        );
        return null;
      }
    }

    // Subsequent delta — push into the live iterator
    existing.iterator.push(payload.delta as string);
    existing.buffer += payload.delta as string;
    return existing;
  }

  async handleCompletion({
    ctx,
    stream,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState;
  }): Promise<void> {
    const { connectionId, channelId } = ctx;
    if (stream.streamFailed && stream.buffer.trim() && stream.target) {
      // Fallback: when native streaming rejected (e.g. Slack's chatStream
      // requires a recipient user/team id that the public-API send path
      // can't supply), post the accumulated buffer non-streaming so the
      // response still lands in the thread instead of being silently dropped.
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
  }
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
 * Slack strategy: skip the SDK streaming path entirely and post a single
 * chunked `markdown_text` message at completion. The Slack streaming API
 * (`chat.appendStream`) auto-splits at fixed sizes (breaking mid-line) and
 * the regular `chat.postMessage` `text` field HTML-escapes `<`/`>`/`&`.
 * Buffer-and-post on completion gives us paragraph-aligned chunks AND
 * markdown-native rendering.
 */
export class SlackResponseStrategy implements PlatformResponseStrategy {
  async disposeOnFullReplacement(_existing: StreamState): Promise<void> {
    // Slack never opens a real streaming target — no async teardown needed.
    // The bridge simply drops the prior state so the next delta opens a
    // fresh buffer (matching pre-strategy semantics: `this.streams.delete`).
  }

  async handleDelta({
    payload,
    existing,
    resolveTarget,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null> {
    if (existing) {
      existing.buffer += payload.delta as string;
      if (payload.isFullReplacement) existing.wasFullyReplaced = true;
      return existing;
    }

    // Resolve the SDK target up front so that if `postSlackMarkdown`
    // can't reach `slackClient.chat.postMessage` at completion (adapter
    // not wired, getAdapter returns undefined, etc.) we still have a
    // non-null fallback and the response doesn't silently disappear.
    const fallbackTarget = await resolveTarget().catch(() => null);
    const iterator = new AsyncPushIterator<string>();
    // Close immediately — we never feed this iterator; completion uses the
    // buffered-post path. Keeping an open iterator around would leak.
    iterator.close();
    return {
      iterator,
      streamPromise: Promise.resolve(),
      buffer: payload.delta as string,
      streamFailed: true, // Force completion to use the post-buffer path
      wasFullyReplaced: !!payload.isFullReplacement,
      target: fallbackTarget,
    };
  }

  async handleCompletion({
    ctx,
    payload,
    stream,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState;
  }): Promise<void> {
    const { connectionId, instance, channelId } = ctx;
    if (!stream.buffer.trim()) return;

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
  }
}

/**
 * Telegram currently uses default behavior (streaming through the Chat SDK).
 * Kept as a named subclass so future Telegram-specific tweaks have an obvious
 * home and the bridge's strategy map reads explicitly.
 */
export class TelegramResponseStrategy extends DefaultResponseStrategy {}

const slackStrategy = new SlackResponseStrategy();
const telegramStrategy = new TelegramResponseStrategy();
const defaultStrategy = new DefaultResponseStrategy();

export function getResponseStrategy(
  platform: string
): PlatformResponseStrategy {
  switch (platform) {
    case "slack":
      return slackStrategy;
    case "telegram":
      return telegramStrategy;
    default:
      return defaultStrategy;
  }
}

export { AsyncPushIterator } from "./async-push-iterator";
