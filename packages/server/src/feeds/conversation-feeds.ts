/**
 * Conversation feeds — the `chat-channel` source kind, enumerated as a VIRTUAL
 * projection over `channel_messages` (one feed per channel, NO `feeds`-table
 * row). Each feed is decorated with its routed agent from
 * `agent_channel_bindings`. See `docs/plans/feeds-and-connections-model.md`.
 *
 * Fenced to (organizationId, connectionId) — the same tenant fence as
 * `readChannelTranscript`; never a global by-platform scan. The hot index
 * `(organization_id, connection_id, channel_id, occurred_at DESC)` backs both
 * the grouping and the `lastActivityAt` ordering.
 */
import { getDb } from "../db/client.js";
import type { FeedSpec } from "./types.js";

/**
 * List the conversation feeds (channels/DMs with captured messages) under a
 * chat connection. `connectionId` is the `agent_connections.id` (text).
 *
 * Channel-name resolution (turning a raw `C0123…` into a human label) is a
 * follow-up — the label falls back to the channel id for now.
 */
export async function listConversationFeeds(
  organizationId: string,
  connectionId: string
): Promise<FeedSpec[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      cm.channel_id,
      cm.platform,
      MAX(cm.occurred_at) AS last_activity_at,
      COUNT(*) AS item_count,
      (
        SELECT b.agent_id
        FROM agent_channel_bindings b
        WHERE b.organization_id = ${organizationId}
          AND b.platform = cm.platform
          -- Bindings store the canonical prefixed id (slack:C...) while
          -- channel_messages stores the bare native id; match either form.
          AND b.channel_id IN (cm.channel_id, cm.platform || ':' || cm.channel_id)
        LIMIT 1
      ) AS target_agent_id
    FROM channel_messages cm
    WHERE cm.organization_id = ${organizationId}
      AND cm.connection_id = ${connectionId}
    GROUP BY cm.channel_id, cm.platform
    ORDER BY MAX(cm.occurred_at) DESC
  `) as Array<{
    channel_id: string;
    platform: string;
    last_activity_at: Date | null;
    item_count: string | number;
    target_agent_id: string | null;
  }>;

  return rows.map((r) => ({
    id: r.channel_id,
    sourceKind: "chat-channel" as const,
    connectionId,
    label: r.channel_id,
    status: "active" as const,
    lastActivityAt: r.last_activity_at
      ? new Date(r.last_activity_at).toISOString()
      : null,
    targetAgentId: r.target_agent_id ?? null,
    itemCount: Number(r.item_count),
  }));
}
