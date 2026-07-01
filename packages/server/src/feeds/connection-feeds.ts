/**
 * Enumerate the feeds under a connection — the connection rail / feeds list.
 *
 * Reads the `feeds` table directly (the single source of truth for all three
 * kinds). A bound chat channel is a real `kind='streaming'` row here — created
 * by `ensureStreamingChannelFeed` at bind time — not an on-the-fly projection,
 * so this one query returns collected, streaming, and virtual feeds uniformly.
 *
 * Fenced to (organizationId, connectionId): never a global scan.
 */
import { getDb } from "../db/client.js";
import type { FeedKind, FeedSpec } from "./types.js";

/**
 * List every live (non-deleted) feed under a connection, newest activity first.
 * `connectionId` is the `connections.id` (bigint, as a string from the route).
 */
export async function listConnectionFeeds(
  organizationId: string,
  connectionId: string
): Promise<FeedSpec[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      f.id::text                       AS id,
      f.feed_key                       AS feed_key,
      f.kind                           AS kind,
      COALESCE(f.display_name, f.feed_key) AS label,
      f.status                         AS status,
      f.virtual                        AS virtual,
      f.last_sync_at                   AS last_sync_at,
      f.items_collected                AS items_collected,
      -- Streaming feeds carry the routed agent via the channel binding; the
      -- feed_key mirrors the binding's channel id (may be platform-prefixed).
      (
        SELECT b.agent_id
        FROM agent_channel_bindings b
        WHERE b.organization_id = f.organization_id
          AND b.connection_id = f.connection_id
          AND b.channel_id = f.feed_key
        LIMIT 1
      )                                AS target_agent_id
    FROM feeds f
    WHERE f.organization_id = ${organizationId}
      AND f.connection_id = ${connectionId}::bigint
      AND f.deleted_at IS NULL
    ORDER BY COALESCE(f.last_sync_at, f.updated_at) DESC
  `) as Array<{
    id: string;
    feed_key: string;
    kind: FeedKind;
    label: string;
    status: "active" | "paused" | "error";
    virtual: boolean;
    last_sync_at: Date | null;
    items_collected: string | number | null;
    target_agent_id: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    feedKey: r.feed_key,
    kind: r.kind,
    connectionId,
    label: r.label,
    status: r.status,
    virtual: r.virtual,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    itemsCollected: Number(r.items_collected ?? 0),
    targetAgentId: r.target_agent_id ?? null,
  }));
}
