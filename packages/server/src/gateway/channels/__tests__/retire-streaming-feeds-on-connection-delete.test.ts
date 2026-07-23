/**
 * A streaming (chat) feed must not outlive its connection.
 *
 * The trigger tests exercise the wiring installed by the migration through a
 * real connection tombstone. The backfill test replays the shipped migration
 * body so its data cleanup cannot drift from production SQL.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

const ORG = "org-streamretire";
const CHANNEL = "slack:D_RETIRE";

async function runMigrationUp(): Promise<void> {
  const sql = await readFile(
    new URL(
      "../../../../../../db/migrations/20260723190000_retire_streaming_feeds_on_connection_delete.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start = sql.indexOf("-- migrate:up");
  const end = sql.indexOf("-- migrate:down");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  await getDb().unsafe(sql.slice(start + "-- migrate:up".length, end));
}

async function insertConnection(opts: {
  slug: string;
  live: boolean;
}): Promise<number> {
  const rows = await getDb()`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      credential_mode, external_tenant_id, config, deleted_at
    ) VALUES (
      ${ORG}, 'slack', ${opts.slug}, 'Workspace', 'active',
      'managed', ${opts.slug},
      '{}', ${opts.live ? null : new Date()}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function insertFeed(
  connectionId: number,
  feedKey: string,
  kind = "streaming",
): Promise<number> {
  const rows = await getDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name,
      status, kind, virtual, config
    ) VALUES (
      ${ORG}, ${connectionId}, ${feedKey}, ${feedKey},
      'active', ${kind}, false, '{"store":"channel_messages"}'
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

/** Tombstone a connection the way the runtime does — the trigger fires on this. */
async function tombstoneConnection(connectionId: number): Promise<void> {
  await getDb()`
    UPDATE connections SET deleted_at = now(), updated_at = now()
    WHERE id = ${connectionId}
  `;
}

async function feedIsLive(feedId: number): Promise<boolean> {
  const rows = await getDb()`
    SELECT 1 FROM feeds WHERE id = ${feedId} AND deleted_at IS NULL
  `;
  return rows.length > 0;
}

async function feedStatus(feedId: number): Promise<string | null> {
  const rows = await getDb()<{ status: string }>`
    SELECT status FROM feeds WHERE id = ${feedId}
  `;
  return rows[0]?.status ?? null;
}

describe("retiring streaming feeds when a connection is tombstoned", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-streamretire", { organizationId: ORG });
  });

  afterAll(async () => {
    await resetTestDatabase();
  });

  test("retires a live connection's streaming feed on tombstone", async () => {
    const conn = await insertConnection({ slug: "slackinst-a", live: true });
    const feed = await insertFeed(conn, CHANNEL);

    expect(await feedIsLive(feed)).toBe(true);

    await tombstoneConnection(conn);

    expect(await feedIsLive(feed)).toBe(false);
    // A retired feed must not read back as active (scheduler/UI depend on this).
    expect(await feedStatus(feed)).toBe("paused");
  });

  test("retires every streaming feed on the connection, not just one", async () => {
    const conn = await insertConnection({ slug: "slackinst-multi", live: true });
    const feeds = [
      await insertFeed(conn, "slack:D_ONE"),
      await insertFeed(conn, "slack:D_TWO"),
      await insertFeed(conn, "slack:C_THREE"),
    ];

    await tombstoneConnection(conn);

    for (const feed of feeds) {
      expect(await feedIsLive(feed)).toBe(false);
    }
  });

  test("leaves feeds on OTHER connections untouched", async () => {
    const dying = await insertConnection({ slug: "slackinst-dying", live: true });
    const survivor = await insertConnection({
      slug: "slackinst-survivor",
      live: true,
    });
    const orphan = await insertFeed(dying, CHANNEL);
    const kept = await insertFeed(survivor, CHANNEL);

    await tombstoneConnection(dying);

    expect(await feedIsLive(orphan)).toBe(false);
    // The survivor's feed shares the channel key but sits on a live connection.
    expect(await feedIsLive(kept)).toBe(true);
  });

  test("does not touch non-streaming feeds on the tombstoned connection", async () => {
    const conn = await insertConnection({ slug: "slackinst-mixed", live: true });
    const streaming = await insertFeed(conn, CHANNEL, "streaming");
    const collected = await insertFeed(conn, "reviews", "collected");

    await tombstoneConnection(conn);

    expect(await feedIsLive(streaming)).toBe(false);
    expect(await feedIsLive(collected)).toBe(true);
  });

  test("backfills live streaming feeds on already-tombstoned connections", async () => {
    const dead = await insertConnection({
      slug: "slackinst-backfill",
      live: false,
    });
    const streaming = await insertFeed(dead, CHANNEL);
    const collected = await insertFeed(dead, "reviews", "collected");

    await runMigrationUp();
    await runMigrationUp();

    expect(await feedIsLive(streaming)).toBe(false);
    expect(await feedStatus(streaming)).toBe("paused");
    expect(await feedIsLive(collected)).toBe(true);
    expect(await feedStatus(collected)).toBe("active");
  });
});
