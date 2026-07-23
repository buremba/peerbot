/**
 * A streaming (chat) feed must not outlive its connection.
 *
 * Until the `retire_streaming_feeds_for_deleted_connection` trigger, tombstoning
 * a connection archived its chat Behaviors but left the derived streaming feeds
 * LIVE on the dead row — the leak the prior one-shot migration had to mop up. The
 * trigger closes that: retiring a connection retires its streaming feeds in the
 * same transaction. These tests drive the trigger through a real tombstone
 * (`UPDATE connections SET deleted_at = now()`), never by replaying SQL, so they
 * exercise the actual wiring installed by the migration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

const ORG = "org-streamretire";
const CHANNEL = "slack:D_RETIRE";

async function insertConnection(opts: {
  slug: string;
  live: boolean;
  credentialMode?: string | null;
}): Promise<number> {
  const rows = await getDb()`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      credential_mode, external_tenant_id, config, deleted_at
    ) VALUES (
      ${ORG}, 'slack', ${opts.slug}, 'Workspace', 'active',
      ${opts.credentialMode === undefined ? "managed" : opts.credentialMode},
      ${opts.slug},
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
    // collected/virtual feeds have their own lifecycle — the trigger is scoped
    // to streaming only, so a data feed on the same connection is untouched.
    const conn = await insertConnection({ slug: "slackinst-mixed", live: true });
    const streaming = await insertFeed(conn, CHANNEL, "streaming");
    const collected = await insertFeed(conn, "reviews", "collected");

    await tombstoneConnection(conn);

    expect(await feedIsLive(streaming)).toBe(false);
    expect(await feedIsLive(collected)).toBe(true);
  });

  test("does not re-retire or resurrect an already-retired feed", async () => {
    // An UPDATE that does not transition deleted_at NULL -> NOT NULL must not
    // fire the trigger; a feed already retired keeps its original deleted_at.
    const conn = await insertConnection({ slug: "slackinst-idem", live: true });
    const feed = await insertFeed(conn, CHANNEL);

    await tombstoneConnection(conn);
    const firstDeletedAt = (
      await getDb()<{ deleted_at: string }>`
        SELECT deleted_at::text AS deleted_at FROM feeds WHERE id = ${feed}
      `
    )[0]?.deleted_at;

    // A later no-op update on the already-dead connection must not touch feeds.
    await getDb()`UPDATE connections SET updated_at = now() WHERE id = ${conn}`;
    const secondDeletedAt = (
      await getDb()<{ deleted_at: string }>`
        SELECT deleted_at::text AS deleted_at FROM feeds WHERE id = ${feed}
      `
    )[0]?.deleted_at;

    expect(await feedIsLive(feed)).toBe(false);
    expect(secondDeletedAt).toBe(firstDeletedAt);
  });

  test("MUTATION GUARD: the assertion depends on the trigger", async () => {
    // Proves the green tests above are not vacuous: with the trigger dropped, a
    // tombstone leaves the feed LIVE — exactly the bug. Reinstalled afterwards so
    // the rest of the suite (and other suites sharing the DB) keep the invariant.
    const fnBody = `
      BEGIN
        UPDATE feeds
        SET deleted_at = current_timestamp, status = 'paused', updated_at = current_timestamp
        WHERE connection_id = NEW.id AND kind = 'streaming' AND deleted_at IS NULL;
        RETURN NEW;
      END`;
    await getDb().unsafe(
      `DROP TRIGGER IF EXISTS retire_streaming_feeds_for_deleted_connection ON connections`,
    );

    const conn = await insertConnection({ slug: "slackinst-mut", live: true });
    const feed = await insertFeed(conn, CHANNEL);
    await tombstoneConnection(conn);

    // Without the trigger, the leak reproduces: feed stays live on the dead row.
    expect(await feedIsLive(feed)).toBe(true);

    // Restore the trigger so no later test inherits the broken state.
    await getDb().unsafe(
      `CREATE OR REPLACE FUNCTION retire_streaming_feeds_for_deleted_connection()
       RETURNS trigger LANGUAGE plpgsql AS $mut$${fnBody}$mut$;
       CREATE TRIGGER retire_streaming_feeds_for_deleted_connection
       AFTER UPDATE OF deleted_at ON connections
       FOR EACH ROW
       WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
       EXECUTE FUNCTION retire_streaming_feeds_for_deleted_connection();`,
    );
  });
});
