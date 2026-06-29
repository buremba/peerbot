/**
 * Streaming feeds — webhook source materialized as a `kind='streaming'` feed.
 * Pins: the helper creates the feed with the scheduler guards (virtual=false +
 * sync-lifecycle columns NULL so check-due-feeds never queues it), and is
 * idempotent under repeated deliveries.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
  ensureWebhookStreamingFeed,
  WEBHOOK_FEED_KEY,
} from "../../../lib/streaming-feeds";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("ensureWebhookStreamingFeed", () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const ws = await TestWorkspace.create({ name: "Streaming Feeds Org" });
    orgId = ws.org.id;
  });

  it("creates a streaming feed with the scheduler guards", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "webhook",
      createDefaultFeed: false,
    });
    const feedId = await ensureWebhookStreamingFeed(conn.id, orgId);
    expect(typeof feedId).toBe("number");

    const sql = getDb();
    const rows = await sql`
      SELECT id, kind, virtual, schedule, next_run_at, checkpoint, status
      FROM feeds
      WHERE connection_id = ${conn.id} AND feed_key = ${WEBHOOK_FEED_KEY}
        AND deleted_at IS NULL
    `;
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.id)).toBe(feedId);
    expect(rows[0]?.kind).toBe("streaming");
    // The two-phase invariant: not virtual, and no sync lifecycle → the
    // scheduler (virtual IS NOT TRUE AND next_run_at <= now()) never queues it.
    expect(rows[0]?.virtual).toBe(false);
    expect(rows[0]?.next_run_at).toBeNull();
    expect(rows[0]?.schedule).toBeNull();
    expect(rows[0]?.checkpoint).toBeNull();
    expect(rows[0]?.status).toBe("active");
  });

  it("is idempotent across repeated deliveries", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "webhook",
      createDefaultFeed: false,
    });
    await ensureWebhookStreamingFeed(conn.id, orgId);
    await ensureWebhookStreamingFeed(conn.id, orgId);
    await ensureWebhookStreamingFeed(conn.id, orgId);

    const sql = getDb();
    const rows = await sql`
      SELECT count(*)::int AS n FROM feeds
      WHERE connection_id = ${conn.id} AND feed_key = ${WEBHOOK_FEED_KEY}
        AND deleted_at IS NULL
    `;
    expect(rows[0]?.n).toBe(1);
  });
});
