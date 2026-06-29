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

async function findWebhookFeedId(
  sql: ReturnType<typeof getDb>,
  connectionId: string | number,
): Promise<number | null> {
  const rows = await sql`
    SELECT id FROM feeds
    WHERE connection_id = ${connectionId}::bigint
      AND feed_key = ${WEBHOOK_FEED_KEY}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Idempotently ensure the streaming feed for a webhook connection, returning
 * its id. Fast path: a lock-free SELECT when the feed already exists (the common
 * case after the first delivery), so the hot ingest path never serializes. Slow
 * path (first delivery only): a transaction-scoped advisory lock on the
 * (connection) tuple serializes the check-then-insert across N replicas, so
 * concurrent first deliveries can't create duplicates. Leaves sync-lifecycle
 * columns NULL (see invariant).
 */
export async function ensureWebhookStreamingFeed(
  connectionId: string | number,
  organizationId: string,
): Promise<number> {
  const sql = getDb();
  const existing = await findWebhookFeedId(sql, connectionId);
  if (existing !== null) return existing;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `webhook-feed:${connectionId}`,
    ]);
    const again = await findWebhookFeedId(tx as ReturnType<typeof getDb>, connectionId);
    if (again !== null) return again;
    const inserted = await tx`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name, status, kind, virtual
      ) VALUES (
        ${organizationId}, ${connectionId}::bigint, ${WEBHOOK_FEED_KEY},
        'Webhook events', 'active', 'streaming', false
      )
      RETURNING id
    `;
    return Number(inserted[0].id);
  });
}

/** Best-effort resolve of the webhook streaming feed id for attributing an
 *  ingested event. Never throws — feed attribution must not break ingestion;
 *  on failure the event lands without a feed_id and is recovered on the next
 *  delivery (the feed is created idempotently). */
export async function resolveWebhookStreamingFeedId(
  connectionId: string | number,
  organizationId: string,
): Promise<number | null> {
  try {
    return await ensureWebhookStreamingFeed(connectionId, organizationId);
  } catch (err) {
    logger.warn(
      { connectionId, err: String(err) },
      "resolve webhook streaming feed failed (non-fatal)",
    );
    return null;
  }
}
