/**
 * Channel-as-streaming-feed materialization.
 *
 * A bound chat channel IS a feed — `kind = 'streaming'`. Its rows are not pulled
 * on a schedule; they arrive in real time and live in `channel_messages` (the
 * transcript), never embedded into `events`. Materializing the channel as a
 * `feeds` row is what lets it surface in the ONE unified Feeds list under its
 * connection, instead of a bespoke channel island.
 *
 * TWO-PHASE INVARIANT (the scheduler still gates on `feeds.virtual` + a non-null
 * `next_run_at`): a streaming feed is written with `virtual = false`, `kind =
 * 'streaming'`, AND its sync-lifecycle columns (`schedule` / `next_run_at` /
 * `checkpoint`) left NULL, so `check-due-feeds` never queues it (it also filters
 * `kind = 'collected'` explicitly). Both guards hold here.
 *
 * Multi-replica safe + idempotent WITHOUT a unique constraint on
 * (connection_id, feed_key): the fast path is a lock-free SELECT (the common
 * case after the first bind); the slow path takes a transaction-scoped advisory
 * lock on the (connection, feed_key) tuple, re-checks, then inserts — so two
 * replicas binding the same channel concurrently can't create duplicates.
 */
import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("channel-feed");

/** The store a streaming channel feed reads from (its config marker). */
const CHANNEL_FEED_STORE = "channel_messages";

async function findStreamingFeedId(
  sql: ReturnType<typeof getDb>,
  connectionId: string | number,
  feedKey: string,
): Promise<number | null> {
  const rows = await sql`
    SELECT id FROM feeds
    WHERE connection_id = ${connectionId}::bigint
      AND feed_key = ${feedKey}
      AND kind = 'streaming'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Idempotently ensure the streaming feed for a bound channel, returning its id.
 * `channelKey` is the channel id exactly as stored on the binding (may be
 * platform-prefixed, e.g. `slack:C…`) — the feed_key mirrors it so the read path
 * (`read_feed`) maps back to the same `channel_messages` rows.
 */
export async function ensureStreamingChannelFeed(opts: {
  connectionId: string | number;
  organizationId: string;
  /** Channel id as stored on the binding — becomes the feed_key. */
  channelKey: string;
  /** Human label for the feed (channel handle when known; else the id). */
  displayName?: string | null;
}): Promise<number> {
  const sql = getDb();
  const { connectionId, organizationId, channelKey } = opts;
  const displayName = opts.displayName ?? channelKey;

  const existing = await findStreamingFeedId(sql, connectionId, channelKey);
  if (existing !== null) return existing;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `channel-feed:${connectionId}:${channelKey}`,
    ]);
    const again = await findStreamingFeedId(
      tx as ReturnType<typeof getDb>,
      connectionId,
      channelKey,
    );
    if (again !== null) return again;
    const inserted = await tx`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name,
        status, kind, virtual, config
      ) VALUES (
        ${organizationId}, ${connectionId}::bigint, ${channelKey}, ${displayName},
        'active', 'streaming', false, ${tx.json({ store: CHANNEL_FEED_STORE })}::jsonb
      )
      RETURNING id
    `;
    return Number(inserted[0].id);
  });
}

/** Best-effort resolve/create — never throws. Feed materialization must not
 *  break the bind path; on failure the channel still binds (recall is unaffected)
 *  and the feed is created on the next bind, idempotently. */
export async function resolveStreamingChannelFeedId(opts: {
  connectionId: string | number;
  organizationId: string;
  channelKey: string;
  displayName?: string | null;
}): Promise<number | null> {
  try {
    return await ensureStreamingChannelFeed(opts);
  } catch (err) {
    logger.warn(
      { connectionId: opts.connectionId, channelKey: opts.channelKey, err: String(err) },
      "ensure streaming channel feed failed (non-fatal)",
    );
    return null;
  }
}

/**
 * Soft-delete the streaming feed for an unbound channel. Best-effort: an unbind
 * already removed the binding (the routing contract); a lingering feed row is
 * cosmetic, so a failure here never fails the unbind.
 */
export async function softDeleteStreamingChannelFeed(opts: {
  connectionId: string | number;
  channelKey: string;
}): Promise<void> {
  const sql = getDb();
  try {
    await sql`
      UPDATE feeds
      SET deleted_at = now(), status = 'paused', updated_at = now()
      WHERE connection_id = ${opts.connectionId}::bigint
        AND feed_key = ${opts.channelKey}
        AND kind = 'streaming'
        AND deleted_at IS NULL
    `;
  } catch (err) {
    logger.warn(
      { connectionId: opts.connectionId, channelKey: opts.channelKey, err: String(err) },
      "soft-delete streaming channel feed failed (non-fatal)",
    );
  }
}
