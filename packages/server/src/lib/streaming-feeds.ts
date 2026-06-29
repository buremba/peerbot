/**
 * Streaming feeds — the `kind = 'streaming'` half of the feed model.
 *
 * A streaming feed is pushed in real time and NEVER polled: its rows arrive via
 * a push handler (webhook ingest, chat transcript), not the sync scheduler. The
 * first streaming source is the webhook connection (`platform: "webhook"`) —
 * a clean `connections` row whose deliveries already land in `events`. This
 * materializes that source as a feed so it surfaces in the unified Feeds list.
 *
 * TWO-PHASE INVARIANT (the scheduler still gates on `feeds.virtual`): a
 * streaming feed is written with `virtual = false` AND its sync-lifecycle
 * columns (`schedule` / `next_run_at` / `checkpoint`) left NULL, so
 * `check-due-feeds` — which selects `virtual IS NOT TRUE AND next_run_at <=
 * now()` — never queues it. Both guards must hold until the scheduler moves to
 * `kind`.
 */
import { createLogger } from "@lobu/core";
import { getDb } from "../db/client";

const logger = createLogger("streaming-feeds");

/** Stable feed_key for a webhook connection's single streaming feed. */
export const WEBHOOK_FEED_KEY = "webhook";

/**
 * Idempotently ensure the streaming feed for a webhook connection. Safe under
 * N replicas: a transaction-scoped advisory lock on the (connection) tuple
 * serializes the check-then-insert across pods, so concurrent deliveries can't
 * create duplicate feeds. Leaves sync-lifecycle columns NULL (see invariant).
 */
export async function ensureWebhookStreamingFeed(
  connectionId: string | number,
  organizationId: string,
): Promise<void> {
  const sql = getDb();
  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `webhook-feed:${connectionId}`,
    ]);
    await tx`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name, status, kind, virtual
      )
      SELECT
        ${organizationId}, ${connectionId}::bigint, ${WEBHOOK_FEED_KEY},
        'Webhook events', 'active', 'streaming', false
      WHERE NOT EXISTS (
        SELECT 1 FROM feeds
        WHERE connection_id = ${connectionId}::bigint
          AND feed_key = ${WEBHOOK_FEED_KEY}
          AND deleted_at IS NULL
      )
    `;
  });
}

/** Fire-and-forget wrapper: materializing the feed must never block a webhook
 *  ack or a turn. Idempotent, so a lost call is recovered on the next delivery. */
export function captureWebhookStreamingFeed(
  connectionId: string | number,
  organizationId: string,
): void {
  ensureWebhookStreamingFeed(connectionId, organizationId).catch((err) => {
    logger.warn(
      { connectionId, err: String(err) },
      "ensure webhook streaming feed failed (non-fatal)",
    );
  });
}
