/**
 * Durable chat transcript capture (`channel_messages`).
 *
 * Persists the messages a connection sees — inbound from users and the bot's own
 * outbound posts — from the real-time event stream, so `read_conversation` can
 * read channel history from Postgres instead of the throttled platform history
 * API. Idempotent on (connection, channel, platform_message_id): webhook
 * redeliveries and the bot's own echoed messages collapse to one row.
 *
 * Capture is best-effort and fire-and-forget — a transcript-write failure must
 * never block a turn or a webhook ack. Call sites use `.catch()`.
 */
import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { resolveChannelMessageSender } from "../../utils/entity-link-upsert.js";
import { stripPlatformPrefix } from "../channels/bound-channels.js";

const logger = createLogger("channel-transcript");

interface PersistChannelMessageParams {
  /** Tenant org the message belongs to (the binding's org for cross-org preview). */
  organizationId: string;
  connectionId: string;
  platform: string;
  /** Platform-native (unprefixed) channel id. */
  channelId: string;
  /** Thread/topic id when the message is in a thread; null for channel-level. */
  threadId?: string | null;
  /** Platform message id (Slack ts, Telegram message_id, …) — the dedup key. */
  platformMessageId: string;
  authorId?: string | null;
  authorName?: string | null;
  /** Workspace/tenant id the author id is scoped to (Slack team_id). Required to
   * attribute a sender — Slack user ids aren't globally unique. Null for the
   * bot's own posts and tenantless platforms. */
  teamId?: string | null;
  isBot: boolean;
  text: string;
  occurredAt: Date;
}

export async function persistChannelMessage(
  params: PersistChannelMessageParams
): Promise<void> {
  const text = params.text?.trim();
  if (
    !text ||
    !params.platformMessageId ||
    !params.channelId ||
    !params.connectionId ||
    !params.organizationId
  ) {
    return;
  }
  // Store the native (unprefixed) channel id. Inbound callers pass the
  // platform-prefixed form (`telegram:123`) while the conversation tools
  // resolve to the stripped native id — normalize here so capture and read
  // agree on one key (else read_conversation silently returns nothing).
  const channelId = stripPlatformPrefix(params.platform, params.channelId);
  const sql = getDb();
  const teamId = params.teamId ?? null;

  // Store-only sender attribution: resolve a real (non-bot) author to its
  // person/$member entity from the normalized identity index. NO event row, no
  // embedding — channel_messages stays out of the knowledge pipeline. Best-effort
  // and isolated: a resolution failure must never block transcript capture.
  let authorEntityId: number | null = null;
  if (!params.isBot && teamId && params.authorId) {
    try {
      authorEntityId = await resolveChannelMessageSender(sql, {
        orgId: params.organizationId,
        teamId,
        authorId: params.authorId,
        authorName: params.authorName ?? null,
        isBot: params.isBot,
      });
    } catch (err) {
      logger.warn(
        { connectionId: params.connectionId, err: String(err) },
        "sender attribution failed (non-fatal)"
      );
    }
  }

  await sql`
    INSERT INTO channel_messages (
      organization_id, connection_id, platform, channel_id, thread_id,
      platform_message_id, author_id, author_name, team_id, author_entity_id,
      is_bot, text, occurred_at
    ) VALUES (
      ${params.organizationId}, ${params.connectionId}, ${params.platform},
      ${channelId}, ${params.threadId ?? null}, ${params.platformMessageId},
      ${params.authorId ?? null}, ${params.authorName ?? null}, ${teamId},
      ${authorEntityId}, ${params.isBot}, ${text}, ${params.occurredAt}
    )
    ON CONFLICT (connection_id, channel_id, platform_message_id) DO NOTHING
  `;
}

/** Fire-and-forget wrapper: capture never blocks a turn or a webhook ack. */
export function captureChannelMessage(params: PersistChannelMessageParams): void {
  persistChannelMessage(params).catch((err) => {
    logger.warn(
      { connectionId: params.connectionId, err: String(err) },
      "transcript capture failed (non-fatal)"
    );
  });
}

interface TranscriptMessage {
  timestamp: string;
  user: string;
  text: string;
  isBot: boolean;
  /**
   * Platform-native message id (Slack `ts`). Exposed so a reader (e.g.
   * read_conversation) can hand it back to react/edit/delete — reacting to a
   * message the agent only READ, not one it sent.
   */
  messageId: string;
  /** Platform thread id if this message is a threaded reply; null at top level. */
  threadId: string | null;
}

/**
 * The most-recent `limit` messages in a channel, oldest-first. Fenced to BOTH
 * the authorized `organizationId` AND `connectionId` (the read_conversation
 * tenant fence) — never a global by-platform lookup. The org scope matters for
 * the shared hosted-preview connection: two orgs could bind the SAME physical
 * channel through it, and capture tags each row with the binding's routing org,
 * so without the org predicate one org's read could surface another's rows.
 * Serves from Postgres, so no platform history-API call (Slack throttles hard).
 */
export async function readChannelTranscript(
  organizationId: string,
  connectionId: string,
  channelId: string,
  limit: number
): Promise<TranscriptMessage[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT author_name, author_id, is_bot, text, occurred_at,
           platform_message_id, thread_id
    FROM channel_messages
    WHERE organization_id = ${organizationId}
      AND connection_id = ${connectionId}
      AND channel_id = ${channelId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `) as Array<{
    author_name: string | null;
    author_id: string | null;
    is_bot: boolean;
    text: string;
    occurred_at: Date;
    platform_message_id: string;
    thread_id: string | null;
  }>;
  // Newest-first from the index; reverse to chronological for the reader.
  return rows.reverse().map((r) => ({
    timestamp: new Date(r.occurred_at).toISOString(),
    user: r.author_name || r.author_id || (r.is_bot ? "assistant" : "user"),
    text: r.text,
    isBot: r.is_bot === true,
    messageId: r.platform_message_id,
    threadId: r.thread_id,
  }));
}
