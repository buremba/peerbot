/**
 * listConnectionFeeds — enumerates every feed under a connection from the feeds
 * table, across kinds. Pins that a streaming (bound channel) feed and a
 * collected (data) feed both surface, with the streaming feed's routed agent
 * decorated from its binding, and that soft-deleted feeds are excluded.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ChannelBindingService } from "../../gateway/channels/binding-service";
import { getTestDb } from "../../__tests__/setup/test-db";
import {
  createTestAgent,
  createTestConnection,
} from "../../__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../__tests__/setup/test-mcp-client";
import { listConnectionFeeds } from "../connection-feeds";

describe("listConnectionFeeds", () => {
  let workspace: TestWorkspace;
  let orgId: string;

  beforeAll(async () => {
    workspace = await TestWorkspace.create({ name: "Connection Feeds Org" });
    orgId = workspace.organizationId;
  });

  it("returns collected + streaming feeds, decorating the streaming feed's agent", async () => {
    const agent = await createTestAgent({ organizationId: orgId });
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Org Slack",
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connections
      SET credential_mode = 'managed', external_tenant_id = ${"T1"}
      WHERE id = ${conn.id}
    `;

    // Collected data feed under the same connection.
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, kind, virtual)
      VALUES (${orgId}, ${conn.id}::bigint, ${"inbox"}, ${"Inbox"}, 'active', 'collected', false)
    `;

    // Streaming feed materialized by binding a channel to the agent.
    const bindings = new ChannelBindingService();
    await bindings.createBinding(agent.id, "slack", "slack:C123", "T1", {
      organizationId: orgId,
    });

    const feeds = await listConnectionFeeds(orgId, String(conn.id));
    const byKind = Object.fromEntries(feeds.map((f) => [f.kind, f]));

    expect(byKind.collected?.feedKey).toBe("inbox");
    expect(byKind.streaming?.feedKey).toBe("slack:C123");
    expect(byKind.streaming?.targetAgentId).toBe(agent.id);
    expect(byKind.streaming?.lastSyncAt).toBeNull();
    expect(byKind.collected?.targetAgentId).toBeNull();
  });

  it("excludes soft-deleted feeds", async () => {
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Org Slack 2",
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, kind, virtual, deleted_at)
      VALUES (${orgId}, ${conn.id}::bigint, ${"gone"}, ${"Gone"}, 'paused', 'collected', false, now())
    `;

    const feeds = await listConnectionFeeds(orgId, String(conn.id));
    expect(feeds.find((f) => f.feedKey === "gone")).toBeUndefined();
  });
});
