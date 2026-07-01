/**
 * Channels as streaming feeds (the feeds-channel consolidation).
 *
 * Pins the productionized behavior:
 *   1. ensureStreamingChannelFeed materializes a channel as a kind='streaming'
 *      feed with the scheduler guards (virtual=false + sync-lifecycle columns
 *      NULL), is idempotent, and soft-deletes cleanly.
 *   2. the sync scheduler (check-due-feeds) never queues a streaming feed, even
 *      with next_run_at in the past — kind is the discriminator.
 *   3. ChannelBindingService.createBinding materializes the channel's feed under
 *      the bound connection; deleteBinding soft-deletes it.
 *   4. manage_feeds read_channel_feed returns the channel transcript.
 *   5. facet derivation: a chat-only connection whose channels are streaming
 *      feeds is NOT mislabeled a data connection.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { ChannelBindingService } from "../../../gateway/channels/binding-service";
import {
  ensureStreamingChannelFeed,
  softDeleteStreamingChannelFeed,
} from "../../../gateway/channels/channel-feed";
import type { Env } from "../../../index";
import { materializeDueFeeds } from "../../../scheduled/check-due-feeds";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

/** Stamp the Stage-2a chat marker + provider tenant on a connection so it reads
 *  as a live bot adapter and createBinding can resolve it as the serving conn. */
async function makeChatConnection(opts: {
  orgId: string;
  teamId: string | null;
}): Promise<{ id: number; slug: string }> {
  const conn = await createTestConnection({
    organization_id: opts.orgId,
    connector_key: "slack",
    display_name: "Org Slack",
    createDefaultFeed: false,
  });
  const sql = getTestDb();
  const [row] = await sql`
    UPDATE connections
    SET credential_mode = 'managed', external_tenant_id = ${opts.teamId}
    WHERE id = ${conn.id}
    RETURNING slug
  `;
  return { id: conn.id, slug: String(row.slug) };
}

describe("channel streaming feeds", () => {
  let workspace: TestWorkspace;
  let orgId: string;

  beforeAll(async () => {
    // Public workspace so the visibility-gate test can exercise an anonymous
    // reader (who can reach a public org but not its private connections).
    workspace = await TestWorkspace.create({
      name: "Channel Feeds Org",
      visibility: "public",
    });
    orgId = workspace.org.id;
  });

  beforeEach(async () => {
    const sql = getTestDb();
    // Clear only the feed/binding/transcript state between cases; keep the org +
    // role fixtures (TestWorkspace) so the typed clients stay valid.
    await sql`DELETE FROM channel_messages WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM agent_channel_bindings WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM feeds WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
  });

  it("materializes a streaming feed with the scheduler guards + idempotency", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C100",
    });
    expect(typeof feedId).toBe("number");

    const sql = getDb();
    const rows = await sql`
      SELECT id, kind, virtual, schedule, next_run_at, checkpoint, status, feed_key, config
      FROM feeds WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe("streaming");
    expect(rows[0]?.virtual).toBe(false);
    // Two-phase invariant: no sync lifecycle → the scheduler never queues it.
    expect(rows[0]?.next_run_at).toBeNull();
    expect(rows[0]?.schedule).toBeNull();
    expect(rows[0]?.checkpoint).toBeNull();
    expect(rows[0]?.feed_key).toBe("slack:C100");
    expect((rows[0]?.config as { store?: string })?.store).toBe("channel_messages");

    // Idempotent: a second ensure returns the same id, no duplicate row.
    const again = await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C100",
    });
    expect(again).toBe(feedId);
    const count = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(Number(count[0]?.n)).toBe(1);

    // Soft-delete retires it.
    await softDeleteStreamingChannelFeed({
      connectionId: conn.id,
      channelKey: "slack:C100",
    });
    const live = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(Number(live[0]?.n)).toBe(0);
  });

  it("the sync scheduler never queues a streaming feed (kind discriminator)", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C200",
    });
    const sql = getDb();
    // Force a past next_run_at to prove `kind = 'collected'` is what excludes it
    // (not merely the NULL next_run_at the materializer leaves).
    await sql`
      UPDATE feeds SET next_run_at = now() - interval '1 hour'
      WHERE connection_id = ${conn.id} AND kind = 'streaming'
    `;
    const result = await materializeDueFeeds({} as Env, sql);
    expect(result.dueFeeds).toBe(0);
    expect(result.runsCreated).toBe(0);
  });

  it("createBinding materializes the channel feed; deleteBinding soft-deletes it", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const svc = new ChannelBindingService();
    const { agentId } = await createTestAgent({ organizationId: orgId });

    await svc.createBinding(agentId, "slack", "slack:C300", "TACME", {
      organizationId: orgId,
    });

    const sql = getDb();
    const bound = await sql`
      SELECT kind, feed_key, connection_id FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(bound.length).toBe(1);
    expect(bound[0]?.kind).toBe("streaming");
    expect(bound[0]?.feed_key).toBe("slack:C300");
    expect(Number(bound[0]?.connection_id)).toBe(conn.id);

    const deleted = await svc.deleteBinding(
      agentId,
      "slack",
      "slack:C300",
      "TACME",
      orgId
    );
    expect(deleted).toBe(true);
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(Number(after[0]?.n)).toBe(0);
  });

  it("read_channel_feed returns the channel transcript", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C400",
    });

    // channel_messages is keyed by the runtime connection id (the slug with the
    // BYO namespace stripped) + the native channel id — mirror what the read
    // path resolves from the feed.
    const runtimeConnId = conn.slug.startsWith("agentconn-")
      ? conn.slug.slice(10)
      : conn.slug;
    const sql = getTestDb();
    for (const [i, [author, isBot, text]] of (
      [
        ["Alice", false, "hello team"],
        ["assistant", true, "hi Alice"],
      ] as Array<[string, boolean, string]>
    ).entries()) {
      await sql`
        INSERT INTO channel_messages (
          organization_id, connection_id, platform, channel_id,
          platform_message_id, author_name, is_bot, text, occurred_at
        ) VALUES (
          ${orgId}, ${runtimeConnId}, 'slack', 'C400',
          ${`m${i}`}, ${author}, ${isBot}, ${text},
          ${new Date(Date.now() + i * 1000)}
        )
      `;
    }

    const result = (await workspace.owner.feeds.manage({
      action: "read_channel_feed",
      feed_id: feedId,
    })) as { messages: Array<{ user: string; text: string; isBot: boolean }> };

    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toMatchObject({ user: "Alice", text: "hello team", isBot: false });
    expect(result.messages[1]).toMatchObject({ user: "assistant", text: "hi Alice", isBot: true });
  });

  it("a chat-only connection with streaming feeds is not labeled a data connection", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C500",
    });

    const result = (await workspace.owner.connections.get(conn.id)) as {
      connection: {
        facets: { data: boolean; chat: boolean };
        feed_count: number;
      };
    };
    // The streaming channel feed shows in the rail (feed_count > 0)…
    expect(result.connection.feed_count).toBeGreaterThan(0);
    // …but it does NOT make the connection claim the data facet.
    expect(result.connection.facets.data).toBe(false);
    expect(result.connection.facets.chat).toBe(true);
  });

  it("does not leak a PRIVATE connection's transcript to an anonymous caller", async () => {
    // A private chat connection: visible only to its creator / org admins.
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
      UPDATE connections SET credential_mode = 'managed', external_tenant_id = 'TPRIV'
      WHERE id = ${priv.id}
    `;
    const slugRow = (await sql`SELECT slug FROM connections WHERE id = ${priv.id}`) as Array<{
      slug: string;
    }>;
    const runtimeConnId = slugRow[0].slug.startsWith("agentconn-")
      ? slugRow[0].slug.slice(10)
      : slugRow[0].slug;
    const feedId = await ensureStreamingChannelFeed({
      connectionId: priv.id,
      organizationId: orgId,
      channelKey: "slack:CPRIV",
    });
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES (
        ${orgId}, ${runtimeConnId}, 'slack', 'CPRIV',
        'mp', 'Secret', false, 'private secret message', NOW()
      )
    `;

    // Owner (creator) CAN read it.
    const ownerRes = (await workspace.owner.feeds.manage({
      action: "read_channel_feed",
      feed_id: feedId,
    })) as { messages?: unknown[]; error?: string };
    expect(ownerRes.messages?.length).toBe(1);

    // Anonymous reader of the public org must NOT — the gate hides the private
    // connection's feed, so the transcript is never resolved.
    const anonRes = (await workspace.asAnonymous().feeds.manage({
      action: "read_channel_feed",
      feed_id: feedId,
    })) as { messages?: unknown[]; error?: string };
    expect(anonRes.messages).toBeUndefined();
    expect(anonRes.error).toBe("Feed not found");
  });
});
