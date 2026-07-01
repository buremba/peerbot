/**
 * Streaming (chat-channel) feed as a watcher @feed source — the membership-gated
 * read of `channel_messages`.
 *
 * A streaming @feed compiles to a read over `channel_messages` (not `events`),
 * and that read is gated per-channel by `compileChannelMessagesVisibility`:
 *
 *   1. On a NON-enforced connection, a headless watcher run (null principal)
 *      reads the transcript — org-open channels are usable as sources.
 *   2. On an ACL-enforced connection, a headless run reads NOTHING — enforced
 *      channel content never reaches the shared recap. THE security property.
 *   3. On an ACL-enforced connection, a member (auth $member with a `member_of`
 *      edge to the channel) DOES read it — the gate is membership, not blanket
 *      denial.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestDb } from "../../setup/test-db";
import { createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";
import { buildSlackChannelGraph } from "../../../authz/slack-channel-graph";
import { ensureStreamingChannelFeed } from "../../../gateway/channels/channel-feed";
import { slugToRuntimeConnectionId } from "../../../lobu/stores/connections-projection";
import { normalizeWatcherSources } from "../../../watchers/source-refs";
import { executeDataSources } from "../../../utils/execute-data-sources";
import { ensureMemberEntity } from "../../../utils/member-entity";
import type { DbClient } from "../../../db/client";

const TEAM_ID = "TACME";
const CHANNEL = "C900";
const FEED_KEY = `slack:${CHANNEL}`;

describe("streaming feed as a watcher @feed source", () => {
  let workspace: TestWorkspace;
  let orgId: string;

  beforeAll(async () => {
    workspace = await TestWorkspace.create({ name: "Channel Feed Source Org" });
    orgId = workspace.org.id;
  });

  beforeEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM channel_messages WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM authz_source_acl_state WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM entity_relationships WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM entity_identities WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM feeds WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
    // Keep the workspace's own $member/entities intact; only clear source state.
    await sql`
      DELETE FROM entities
      WHERE organization_id = ${orgId}
        AND (metadata->>'source' = 'watcher_promotion' OR entity_type_id IN (
          SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug IN ('channel', '$member')
        ))
    `;
  });

  /** A chat (slack, managed) connection carrying the team id. Returns the id, the
   *  slug, and the runtime id that channel_messages + the ACL state key on. */
  async function makeChatConnection() {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Org Slack",
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    const [row] = await sql`
      UPDATE connections
      SET credential_mode = 'managed', external_tenant_id = ${TEAM_ID}
      WHERE id = ${conn.id}
      RETURNING slug
    `;
    const slug = String(row.slug);
    return { id: conn.id, slug, runtimeId: slugToRuntimeConnectionId(slug) };
  }

  async function seedTranscript(runtimeId: string) {
    const sql = getTestDb();
    for (const [i, [author, text]] of (
      [
        ["Alice", "channel secret one"],
        ["Bob", "channel secret two"],
      ] as Array<[string, string]>
    ).entries()) {
      await sql`
        INSERT INTO channel_messages (
          organization_id, connection_id, platform, channel_id,
          platform_message_id, author_name, is_bot, text, occurred_at
        ) VALUES (
          ${orgId}, ${runtimeId}, 'slack', ${CHANNEL},
          ${`m${i}`}, ${author}, false, ${text},
          ${new Date(Date.now() + i * 1000)}
        )
      `;
    }
  }

  /** Compile @feed:<key> to its channel_messages query and run it as the given
   *  reader — exactly the watcher read path (normalize → executeDataSources). */
  async function readAsWatcherSource(
    opts: string | null | { userId?: string | null; windowStart?: string; windowEnd?: string }
  ): Promise<unknown[]> {
    const o = typeof opts === "object" && opts !== null ? opts : { userId: opts };
    const sql = getTestDb();
    const normalized = await normalizeWatcherSources(sql as unknown as DbClient, orgId, [
      { name: "chat", query: `@feed:${FEED_KEY}` },
    ]);
    expect(normalized[0].query).toContain("channel_messages");
    const out = await executeDataSources(
      [{ name: "chat", query: normalized[0].query }],
      {
        organizationId: orgId,
        userId: o.userId ?? null,
        windowStart: o.windowStart,
        windowEnd: o.windowEnd,
      },
      sql as unknown as DbClient
    );
    return out.chat ?? [];
  }

  it("a streaming @feed compiles to kind 'channel' (prompt context, not event-signed)", async () => {
    // Regression for the complete_window FK: a channel source's rows carry
    // channel_messages.id, which is NOT an events.id. If the source were kind
    // 'event' its ids would be signed into the window_token content_ids and
    // complete_window would insert them into watcher_window_events.event_id (FK
    // to events) → break. kind 'channel' keeps them out of eventSourceNames.
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    const sql = getTestDb();
    const normalized = await normalizeWatcherSources(sql as unknown as DbClient, orgId, [
      { name: "chat", query: `@feed:${FEED_KEY}` },
    ]);
    expect(normalized[0].kind).toBe("channel");
    expect(normalized[0].query).toContain("channel_messages");
  });

  it("a headless watcher reads a NON-enforced channel's transcript", async () => {
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    await seedTranscript(conn.runtimeId);

    // No ACL graph → connection not enforced → headless (null principal) reads it.
    const rows = (await readAsWatcherSource(null)) as Array<{ text: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.text).sort()).toEqual([
      "channel secret one",
      "channel secret two",
    ]);
  });

  it("a headless watcher reads NOTHING from an ACL-enforced channel (no leak)", async () => {
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    await seedTranscript(conn.runtimeId);

    // Materialize the membership graph → marks the connection ACL-enforced.
    await buildSlackChannelGraph({
      organizationId: orgId,
      connectionId: conn.runtimeId,
      teamId: TEAM_ID,
      channels: [{ channelId: CHANNEL, name: "general", memberSlackUserIds: ["UMEMBER"] }],
    });

    // Headless run has no $member → fails closed on the enforced channel.
    const rows = await readAsWatcherSource(null);
    expect(rows.length).toBe(0);
  });

  it("reads NOTHING from a connection whose ACL snapshot went STALE (fail closed)", async () => {
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    await seedTranscript(conn.runtimeId);

    // The connection WAS onboarded into authz (acl row exists) but its snapshot
    // aged out beyond the freshness window — full+fresh yet last_synced_at old, so
    // it is NOT in the fresh-enforced set. A bare `NOT IN (enforced)` would leak
    // it; the gate must fail closed because a row exists.
    const sql = getTestDb();
    await sql`
      INSERT INTO authz_source_acl_state
        (organization_id, connection_id, acl_support, freshness_state, last_synced_at, created_at, updated_at)
      VALUES (${orgId}, ${conn.runtimeId}, 'full', 'fresh', now() - interval '2 hours', now(), now())
    `;

    const rows = await readAsWatcherSource(null);
    expect(rows.length).toBe(0);
  });

  it("a channel MEMBER reads the enforced channel (gate is membership, not denial)", async () => {
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    await seedTranscript(conn.runtimeId);

    const graph = await buildSlackChannelGraph({
      organizationId: orgId,
      connectionId: conn.runtimeId,
      teamId: TEAM_ID,
      channels: [{ channelId: CHANNEL, name: "general", memberSlackUserIds: [] }],
    });
    const channelEntityId = graph.channelEntityIds[CHANNEL];
    expect(typeof channelEntityId).toBe("number");

    // Provision the reader's $member (writes the auth_user_id/auth:signup identity
    // the gate resolves), then give it a member_of edge to the channel entity —
    // the same shape the live ACL sync would produce for a channel member.
    const readerUserId = workspace.users.owner.id;
    await ensureMemberEntity({
      organizationId: orgId,
      userId: readerUserId,
      name: "Reader",
      email: `reader-${readerUserId}@example.com`,
    });
    const sql = getTestDb();
    const [member] = await sql`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = '$member'
      JOIN entity_identities ei ON ei.entity_id = e.id
        AND ei.namespace = 'auth_user_id' AND ei.identifier = ${readerUserId}
        AND ei.source_connector = 'auth:signup'
      WHERE e.organization_id = ${orgId} AND e.deleted_at IS NULL
      LIMIT 1
    `;
    const [mot] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${orgId} AND slug = 'member_of' AND status = 'active'
      LIMIT 1
    `;
    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id, created_at, updated_at
      ) VALUES (
        ${orgId}, ${member.id}, ${channelEntityId}, ${mot.id}, NOW(), NOW()
      )
    `;

    const rows = (await readAsWatcherSource(readerUserId)) as Array<{ text: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.text).sort()).toEqual([
      "channel secret one",
      "channel secret two",
    ]);
  });

  it("does not expose a PRIVATE connection's channel to a headless watcher (connection visibility)", async () => {
    // A private chat connection: visible only to its creator, even though its
    // channel isn't ACL-enforced. The membership gate alone (not-graphed →
    // passthrough) would leak it to a headless watcher; connection visibility
    // must also apply.
    const priv = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Private Slack",
      visibility: "private",
      created_by: workspace.users.owner.id,
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connections SET credential_mode = 'managed', external_tenant_id = ${TEAM_ID}
      WHERE id = ${priv.id}
    `;
    const [row] = await sql`SELECT slug FROM connections WHERE id = ${priv.id}`;
    const runtimeId = slugToRuntimeConnectionId(String(row.slug));
    await ensureStreamingChannelFeed({
      connectionId: priv.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    await seedTranscript(runtimeId);

    // Headless (null principal) → private connection hidden → nothing.
    expect((await readAsWatcherSource({ userId: null })).length).toBe(0);
    // The creator can read it.
    expect(
      (await readAsWatcherSource({ userId: workspace.users.owner.id })).length
    ).toBe(2);
  });

  it("a channel @feed source respects the watcher window bounds", async () => {
    const conn = await makeChatConnection();
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: FEED_KEY,
    });
    const sql = getTestDb();
    // One message inside the window, one well before it.
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES
        (${orgId}, ${conn.runtimeId}, 'slack', ${CHANNEL}, 'w-in', 'A', false, 'inside window', NOW()),
        (${orgId}, ${conn.runtimeId}, 'slack', ${CHANNEL}, 'w-out', 'B', false, 'before window', NOW() - interval '2 days')
    `;

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 60 * 1000).toISOString();
    const rows = (await readAsWatcherSource({
      userId: null,
      windowStart,
      windowEnd,
    })) as Array<{ text: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe("inside window");
  });
});
