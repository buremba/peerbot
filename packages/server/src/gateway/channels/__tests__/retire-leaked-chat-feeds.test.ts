/**
 * Streaming chat feeds leaked onto retired connections.
 *
 * A streaming feed is keyed by the numeric `connections.id` and is soft-deleted
 * only on an explicit unlink — nothing retires feeds when a connection is. So a
 * workspace re-installed under a different tenant key leaves the previous
 * generation's feed LIVE on a dead connection, one per install.
 *
 * Prod 2026-07-23 (org_lobucrm): feeds 434 and 437 sit live on dead connections
 * for one DM channel while feed 450 serves that channel on the live connection.
 *
 * The migration statement is sliced out of the shipped file and replayed here,
 * so these tests cannot drift from the SQL that actually runs.
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

const ORG = "org-feedleak";
const CHANNEL = "slack:D_LEAK";

/** Replay the migration's `migrate:up` body against the seeded rows. */
async function runCleanup(): Promise<void> {
  const sql = await readFile(
    new URL(
      "../../../../../../db/migrations/20260723160000_retire_leaked_chat_feeds.sql",
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
  tenantId: string;
  live: boolean;
  organizationId?: string;
  credentialMode?: string | null;
}): Promise<number> {
  const rows = await getDb()`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      credential_mode, external_tenant_id, config, deleted_at
    ) VALUES (
      ${opts.organizationId ?? ORG}, 'slack', ${opts.slug}, 'Workspace', 'active',
      ${opts.credentialMode === undefined ? "managed" : opts.credentialMode},
      ${opts.tenantId},
      ${getDb().json({ chatMetadata: { teamId: opts.tenantId } })},
      ${opts.live ? null : new Date()}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function insertFeed(
  connectionId: number,
  feedKey: string,
  organizationId = ORG,
  kind = "streaming",
): Promise<number> {
  const rows = await getDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name,
      status, kind, virtual, config
    ) VALUES (
      ${organizationId}, ${connectionId}, ${feedKey}, ${feedKey},
      'active', ${kind}, false, '{"store":"channel_messages"}'
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function feedIsLive(feedId: number): Promise<boolean> {
  const rows = await getDb()`
    SELECT 1 FROM feeds WHERE id = ${feedId} AND deleted_at IS NULL
  `;
  return rows.length > 0;
}

describe("retiring leaked chat feeds", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-feedleak", { organizationId: ORG });
  });

  afterAll(async () => {
    await resetTestDatabase();
  });

  test("retires a duplicate feed left on a retired connection", async () => {
    // The prod shape: retired under one tenant key, live under another, both
    // serving the same channel.
    const dead = await insertConnection({
      slug: "slackinst-dead",
      tenantId: "E_ENTERPRISE",
      live: false,
    });
    const live = await insertConnection({
      slug: "slackinst-live",
      tenantId: "T_WORKSPACE",
      live: true,
    });
    const orphan = await insertFeed(dead, CHANNEL);
    const serving = await insertFeed(live, CHANNEL);

    await runCleanup();

    expect(await feedIsLive(orphan)).toBe(false);
    // The feed that actually routes must survive.
    expect(await feedIsLive(serving)).toBe(true);
  });

  test("retires every generation's orphan, not just the newest", async () => {
    // Prod accumulated one orphan per install; all of them must go.
    const live = await insertConnection({
      slug: "slackinst-live-multi",
      tenantId: "T_WORKSPACE",
      live: true,
    });
    const serving = await insertFeed(live, CHANNEL);
    const orphans: number[] = [];
    for (const tenant of ["T_GEN1", "E_GEN2", "T_GEN3"]) {
      const dead = await insertConnection({
        slug: `slackinst-${tenant}`,
        tenantId: tenant,
        live: false,
      });
      orphans.push(await insertFeed(dead, CHANNEL));
    }

    await runCleanup();

    for (const orphan of orphans) {
      expect(await feedIsLive(orphan)).toBe(false);
    }
    expect(await feedIsLive(serving)).toBe(true);
  });

  test("keeps an orphan that is the org's only feed for the channel", async () => {
    // Retiring this would remove the last feed for the channel rather than a
    // duplicate — prod has exactly this case in a second organization.
    const dead = await insertConnection({
      slug: "slackinst-only",
      tenantId: "E_ONLY",
      live: false,
    });
    const orphan = await insertFeed(dead, CHANNEL);

    await runCleanup();

    expect(await feedIsLive(orphan)).toBe(true);
  });

  test("never retires a feed belonging to another organization", async () => {
    const OTHER = "org-feedleak-other";
    await seedAgentRow("agent-other", { organizationId: OTHER });
    const deadOther = await insertConnection({
      slug: "slackinst-other-dead",
      tenantId: "E_OTHER",
      live: false,
      organizationId: OTHER,
    });
    const orphanOther = await insertFeed(deadOther, CHANNEL, OTHER);

    // A live feed in THIS org must not license retiring the other org's.
    const live = await insertConnection({
      slug: "slackinst-mine",
      tenantId: "T_MINE",
      live: true,
    });
    await insertFeed(live, CHANNEL);

    await runCleanup();

    expect(await feedIsLive(orphanOther)).toBe(true);
  });

  test("never retires a non-streaming feed that shares a feed key", async () => {
    // Unrelated connectors reuse feed keys (`reviews`, `content`, `home_feed`
    // all collide in prod); retiring those would stop their ingestion.
    const dead = await insertConnection({
      slug: "slackinst-dead-collected",
      tenantId: "E_COLLECTED",
      live: false,
    });
    const live = await insertConnection({
      slug: "slackinst-live-collected",
      tenantId: "T_COLLECTED",
      live: true,
    });
    const collected = await insertFeed(dead, "reviews", ORG, "collected");
    await insertFeed(live, "reviews", ORG, "collected");

    await runCleanup();

    expect(await feedIsLive(collected)).toBe(true);
  });

  test("never retires a feed on a live connection", async () => {
    const live = await insertConnection({
      slug: "slackinst-both-live",
      tenantId: "T_LIVE",
      live: true,
    });
    const other = await insertConnection({
      slug: "slackinst-second-live",
      tenantId: "T_LIVE_TWO",
      live: true,
    });
    const feedA = await insertFeed(live, CHANNEL);
    const feedB = await insertFeed(other, CHANNEL);

    await runCleanup();

    expect(await feedIsLive(feedA)).toBe(true);
    expect(await feedIsLive(feedB)).toBe(true);
  });

  test("never retires a non-chat connection's feed", async () => {
    // `credential_mode IS NULL` marks a non-chat connection; those are outside
    // this cleanup entirely.
    const dead = await insertConnection({
      slug: "agentconn-dead-nonchat",
      tenantId: "T_NONCHAT",
      live: false,
      credentialMode: null,
    });
    const live = await insertConnection({
      slug: "slackinst-live-nonchat",
      tenantId: "T_NONCHAT_LIVE",
      live: true,
    });
    const nonChat = await insertFeed(dead, CHANNEL);
    await insertFeed(live, CHANNEL);

    await runCleanup();

    expect(await feedIsLive(nonChat)).toBe(true);
  });
});
