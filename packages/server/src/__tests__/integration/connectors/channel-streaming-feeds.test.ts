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
 *   4. manage_feeds read_feed dispatches on kind: a streaming feed returns its
 *      channel transcript, a collected feed returns metadata + recent runs.
 *   5. facet derivation: a chat-only connection whose channels are streaming
 *      feeds is NOT mislabeled a data connection.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  slackAclSource,
  slackChannelKey,
  slackChannelsToResources,
} from "@lobu/connectors/slack-identity";
import { buildAccessGraph } from "../../../authz/access-graph";
import { getDb } from "../../../db/client";
import { ChannelBindingService } from "../../../gateway/channels/binding-service";
import {
  ensureStreamingChannelFeed,
  softDeleteStreamingChannelFeed,
} from "../../../gateway/channels/channel-feed";
import type { Env } from "../../../index";
import { slugToRuntimeConnectionId } from "../../../lobu/stores/connections-projection";
import { materializeDueFeeds } from "../../../scheduled/check-due-feeds";
import { ensureMemberEntity } from "../../../utils/member-entity";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

let chatConnectionSeq = 0;

/** Stamp the Stage-2a chat marker + provider tenant on a connection so it reads
 *  as a live bot adapter and createBinding can resolve it as the serving conn. */
async function makeChatConnection(opts: {
  orgId: string;
  teamId: string | null;
}): Promise<{ id: number; slug: string }> {
  chatConnectionSeq += 1;
  const sql = getTestDb();
  // The chat facet is declared by the CONNECTOR — via the `x-lobu-chat-platform`
  // marker in its options_schema — not implied by having a credential. Seed a
  // matching slack connector_definition so the facet derivation sees the marker.
  await sql`
    INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, feeds_schema,
       actions_schema, options_schema, status)
    VALUES (${opts.orgId}, 'slack', 'Slack', '1.0.0',
      '{"methods":[{"type":"app_installation"}]}'::jsonb, '{}'::jsonb, NULL,
      '{"x-lobu-chat-platform":"slack"}'::jsonb, 'active')
    ON CONFLICT DO NOTHING
  `;
  const conn = await createTestConnection({
    organization_id: opts.orgId,
    connector_key: "slack",
    display_name: `Org Slack ${opts.orgId} ${opts.teamId ?? "none"} ${chatConnectionSeq}`,
    createDefaultFeed: false,
  });
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
    // ACL/graph state the membership-gate test materializes.
    await sql`DELETE FROM authz_source_acl_state WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM entity_relationships WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM entity_identities WHERE organization_id = ${orgId}`;
    await sql`
      DELETE FROM entities
      WHERE organization_id = ${orgId}
        AND entity_type_id IN (
          SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug IN ('channel', '$member')
        )
    `;
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
      connectionId: String(conn.id),
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
      "slack:C300",
      String(conn.id),
      orgId
    );
    expect(deleted).toBe(true);
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(Number(after[0]?.n)).toBe(0);
  });

  it("read_feed returns a streaming feed's transcript (kind dispatch)", async () => {
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
      action: "read_feed",
      feed_id: feedId,
    })) as {
      kind: string;
      messages: Array<{ user: string; text: string; isBot: boolean }>;
    };

    expect(result.kind).toBe("streaming");
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toMatchObject({ user: "Alice", text: "hello team", isBot: false });
    expect(result.messages[1]).toMatchObject({ user: "assistant", text: "hi Alice", isBot: true });
  });

  it("trigger_feed rejects a streaming feed (only collected feeds sync)", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C600",
    });

    const res = (await workspace.owner.feeds.manage({
      action: "trigger_feed",
      feed_id: feedId,
    })) as { triggered?: boolean; run_id?: string; error?: string };

    // A streaming feed has no connector fetch for its feed_key — triggering a
    // sync would spawn a run against nothing. Reject before createSyncRun.
    expect(res.triggered).toBeUndefined();
    expect(res.run_id).toBeUndefined();
    expect(res.error).toContain("only collected feeds");
  });

  it("read_feed on a collected feed returns runs, not a transcript", async () => {
    // A plain connection with the default kind='collected' feed.
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Collected Slack",
    });
    const sql = getTestDb();
    const feedRow = (await sql`
      SELECT id, kind FROM feeds WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `) as Array<{ id: number; kind: string }>;
    expect(feedRow[0]?.kind).toBe("collected");

    // read_feed dispatches on kind: a collected feed resolves to its metadata +
    // recent sync runs, NEVER a channel_messages transcript.
    const res = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedRow[0].id,
    })) as {
      kind?: string;
      feed?: { id: number };
      recent_runs?: unknown[];
      messages?: unknown[];
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.kind).toBe("collected");
    expect(res.messages).toBeUndefined();
    expect(Array.isArray(res.recent_runs)).toBe(true);
    expect(res.feed?.id).toBe(feedRow[0].id);
  });

  it("deleteAllBindings soft-deletes each unbound channel's streaming feed", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const svc = new ChannelBindingService();
    const { agentId } = await createTestAgent({ organizationId: orgId });

    await svc.createBinding(agentId, "slack", "slack:C700", "TACME", {
      organizationId: orgId,
      connectionId: String(conn.id),
    });
    await svc.createBinding(agentId, "slack", "slack:C701", "TACME", {
      organizationId: orgId,
      connectionId: String(conn.id),
    });

    const sql = getDb();
    const before = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId} AND kind = 'streaming' AND deleted_at IS NULL
    `;
    expect(Number(before[0]?.n)).toBe(2);

    const removed = await svc.deleteAllBindings(agentId, orgId);
    expect(removed).toBe(2);

    // Both streaming feeds are retired — no live orphan feed left behind.
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId} AND kind = 'streaming' AND deleted_at IS NULL
    `;
    expect(Number(after[0]?.n)).toBe(0);
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

  it("read_feed gates an ACL-enforced channel by membership, not just connection visibility", async () => {
    // The owner can SEE any connection (no visibility filter), but must not read
    // an enforced Slack channel's transcript unless they're a channel member.
    const conn = await makeChatConnection({ orgId, teamId: "TENF" });
    const feedId = await ensureStreamingChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:CENF",
    });
    const runtimeConnId = slugToRuntimeConnectionId(conn.slug);
    const sql = getTestDb();
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES (
        ${orgId}, ${runtimeConnId}, 'slack', 'CENF',
        'me1', 'Insider', false, 'enforced channel secret', NOW()
      )
    `;

    // Not enforced yet → owner reads it.
    const before = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[] };
    expect(before.messages?.length).toBe(1);

    // Enforce the connection's ACL; owner is NOT a channel member.
    const graph = await buildAccessGraph({
      organizationId: orgId,
      connectionId: runtimeConnId,
      connectorKey: slackAclSource.key,
      resourceType: slackAclSource.resourceType,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources("TENF", [
        { channelId: "CENF", name: "secret", memberSlackUserIds: [] },
      ]),
    });

    const blocked = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[] };
    expect(blocked.messages?.length).toBe(0); // membership gate fires

    // Make the owner a channel member → they can read it again.
    const channelEntityId =
      graph.resourceEntityIds[slackChannelKey("TENF", "CENF")];
    await ensureMemberEntity({
      organizationId: orgId,
      userId: workspace.users.owner.id,
      name: "Owner",
      email: `owner-${workspace.users.owner.id}@example.com`,
    });
    const [member] = await sql`
      SELECT e.id FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = '$member'
      JOIN entity_identities ei ON ei.entity_id = e.id
        AND ei.namespace = 'auth_user_id' AND ei.identifier = ${workspace.users.owner.id}
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
      ) VALUES (${orgId}, ${member.id}, ${channelEntityId}, ${mot.id}, NOW(), NOW())
    `;

    const allowed = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[] };
    expect(allowed.messages?.length).toBe(1);
  });

  it("does not leak a PRIVATE connection's transcript to an anonymous caller", async () => {
    // A private chat connection: visible only to its creator / org admins.
    chatConnectionSeq += 1;
    const priv = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: `Private Slack ${orgId} TPRIV ${chatConnectionSeq}`,
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
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[]; error?: string };
    expect(ownerRes.messages?.length).toBe(1);

    // Anonymous reader of the public org must NOT — the gate hides the private
    // connection's feed, so the transcript is never resolved.
    const anonRes = (await workspace.asAnonymous().feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[]; error?: string };
    expect(anonRes.messages).toBeUndefined();
    expect(anonRes.error).toBe("Feed not found");
  });
});
