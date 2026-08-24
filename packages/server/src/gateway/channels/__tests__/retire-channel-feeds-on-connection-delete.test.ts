/**
 * A channel-message feed must not outlive its connection.
 *
 * The trigger tests exercise the wiring installed by the migration through a
 * real connection tombstone. The backfill test replays the shipped migration
 * body so its data cleanup cannot drift from production SQL.
 */
import { readFile } from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
      "../../../../../../db/migrations/20260824120000_channel_feed_storage_guard.sql",
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
  store: "channel_messages" | "events" = "channel_messages",
): Promise<number> {
  const rows = await getDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name,
      status, config
    ) VALUES (
      ${ORG}, ${connectionId}, ${feedKey}, ${feedKey},
      'active', ${getDb().json({ store })}
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

/** Seed the pre-migration orphan shape without leaking disabled schema state. */
async function reviveFeedWithoutGuard(feedId: number): Promise<void> {
  await getDb().begin(async (tx) => {
    await tx.unsafe(
		"ALTER TABLE feeds DISABLE TRIGGER guard_channel_feed_connection",
    );
    await tx`
      UPDATE feeds
      SET deleted_at = NULL, status = 'active', updated_at = now()
      WHERE id = ${feedId}
    `;
    await tx.unsafe(
		"ALTER TABLE feeds ENABLE TRIGGER guard_channel_feed_connection",
    );
  });
}

describe("retiring channel feeds with dead connections", () => {
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

  test("tombstoning a connection retires only its channel-message feeds", async () => {
    const dying = await insertConnection({
      slug: "slackinst-dying",
      live: true,
    });
    const survivor = await insertConnection({
      slug: "slackinst-survivor",
      live: true,
    });
    const retired = [
      await insertFeed(dying, CHANNEL),
      await insertFeed(dying, "slack:C_OTHER"),
    ];
    const eventFeed = await insertFeed(dying, "reviews", "events");
    const kept = await insertFeed(survivor, CHANNEL);

    await tombstoneConnection(dying);

    for (const feed of retired) {
      expect(await feedIsLive(feed)).toBe(false);
      expect(await feedStatus(feed)).toBe("paused");
    }
    expect(await feedIsLive(eventFeed)).toBe(true);
    expect(await feedIsLive(kept)).toBe(true);
  });

  test("retires a channel feed written after its connection is tombstoned", async () => {
    const dead = await insertConnection({
      slug: "slackinst-late-feed",
      live: false,
    });

    const channelFeed = await insertFeed(dead, CHANNEL);
    const eventFeed = await insertFeed(dead, "reviews", "events");

    expect(await feedIsLive(channelFeed)).toBe(false);
    expect(await feedStatus(channelFeed)).toBe("paused");
    expect(await feedIsLive(eventFeed)).toBe(true);
  });

  test("backfills live channel feeds on already-tombstoned connections", async () => {
    const dead = await insertConnection({
      slug: "slackinst-backfill",
      live: false,
    });
    const channelFeed = await insertFeed(dead, CHANNEL);
    const eventFeed = await insertFeed(dead, "reviews", "events");
    await reviveFeedWithoutGuard(channelFeed);
    expect(await feedIsLive(channelFeed)).toBe(true);

    await runMigrationUp();
    await runMigrationUp();

    expect(await feedIsLive(channelFeed)).toBe(false);
    expect(await feedStatus(channelFeed)).toBe("paused");
    expect(await feedIsLive(eventFeed)).toBe(true);
    expect(await feedStatus(eventFeed)).toBe("active");
  });
});
