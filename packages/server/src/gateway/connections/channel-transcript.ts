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
  const sql = getDb();
  await sql`
    INSERT INTO channel_messages (
      organization_id, connection_id, platform, channel_id, thread_id,
      platform_message_id, author_id, author_name, is_bot, text, occurred_at
    ) VALUES (
      ${params.organizationId}, ${params.connectionId}, ${params.platform},
      ${params.channelId}, ${params.threadId ?? null}, ${params.platformMessageId},
      ${params.authorId ?? null}, ${params.authorName ?? null}, ${params.isBot},
      ${text}, ${params.occurredAt}
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
}

/**
 * The most-recent `limit` messages in a channel, oldest-first. Scoped to the
 * authorized `connectionId` (the read_conversation tenant fence) — never a
 * global by-platform lookup. Serves from Postgres, so no platform history-API
 * call (which Slack throttles hard).
 */
export async function readChannelTranscript(
  connectionId: string,
  channelId: string,
  limit: number
): Promise<TranscriptMessage[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT author_name, author_id, is_bot, text, occurred_at
    FROM channel_messages
    WHERE connection_id = ${connectionId} AND channel_id = ${channelId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `) as Array<{
    author_name: string | null;
    author_id: string | null;
    is_bot: boolean;
    text: string;
    occurred_at: Date;
  }>;
  // Newest-first from the index; reverse to chronological for the reader.
  return rows.reverse().map((r) => ({
    timestamp: new Date(r.occurred_at).toISOString(),
    user: r.author_name || r.author_id || (r.is_bot ? "assistant" : "user"),
    text: r.text,
    isBot: r.is_bot === true,
  }));
}
