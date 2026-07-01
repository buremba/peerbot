/**
 * Parity tests for the channel-binding actions folded into manage_connections
 * from the retired `gateway/routes/public/channels.ts` HTTP routes.
 *
 * Covers per-folded-action behavior + the two sharp edges the HTTP routes had:
 *   - the per-agent tenant fence (assertAgentInOrg): a cross-org agent id is
 *     never reachable, even for an org owner;
 *   - connect_channel_dm's bot-token resolution under orgContext + the canonical
 *     `slack:<id>` binding key. The Slack Web API is mocked (no live Slack).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { persistSecretValue, SecretStoreRegistry } from "../../../gateway/secrets";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { ChannelBindingService } from "../../../gateway/channels/binding-service";
import { __setSlackWebApiForTests } from "../../../tools/admin/manage_connections/handlers/channel-bindings";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestOrganization,
} from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const TEAM = "TACME";

async function makeManagedSlackConnection(opts: {
  orgId: string;
  slug: string;
  teamId: string;
}): Promise<number> {
  const conn = await createTestConnection({
    organization_id: opts.orgId,
    connector_key: "slack",
    slug: opts.slug,
    display_name: "Org Slack",
    createDefaultFeed: false,
  });
  const sql = getTestDb();
  await sql`
    UPDATE connections
    SET credential_mode = 'managed', external_tenant_id = ${opts.teamId}
    WHERE id = ${conn.id}
  `;
  return conn.id;
}

describe("manage_connections channel-binding actions", () => {
  let workspace: TestWorkspace;
  let orgId: string;
  let agentId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: "Channel Actions Org" });
    orgId = workspace.org.id;
    ({ agentId } = await createTestAgent({ organizationId: orgId }));
  });

  beforeEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM agent_channel_bindings WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM feeds WHERE organization_id = ${orgId}`;
    // Chat connections are uniquely constrained per (org, connector, tenant)
    // while active — clear them between cases so each test makes its own.
    await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM app_installations WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM account WHERE "userId" = ${workspace.users.owner.id}`;
  });

  it("bind_channel → list_channel_bindings → unbind_channel round-trips", async () => {
    await makeManagedSlackConnection({ orgId, slug: "slackinst-rt", teamId: TEAM });

    const bound = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: agentId,
      platform: "slack",
      channel_id: "slack:C111",
      team_id: TEAM,
    })) as { success?: boolean; error?: string };
    expect(bound.success).toBe(true);

    const listed = (await workspace.owner.connections.manage({
      action: "list_channel_bindings",
      agent_id: agentId,
    })) as { bindings: Array<{ channelId: string; teamId?: string }> };
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0].channelId).toBe("slack:C111");

    // Phase-2 materialization rides through the same path.
    const sql = getDb();
    const feeds = await sql`
      SELECT kind, feed_key FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(feeds).toHaveLength(1);
    expect(feeds[0]?.kind).toBe("streaming");

    const unbound = (await workspace.owner.connections.manage({
      action: "unbind_channel",
      agent_id: agentId,
      platform: "slack",
      channel_id: "slack:C111",
      team_id: TEAM,
    })) as { success?: boolean };
    expect(unbound.success).toBe(true);

    const after = (await workspace.owner.connections.manage({
      action: "list_channel_bindings",
      agent_id: agentId,
    })) as { bindings: unknown[] };
    expect(after.bindings).toHaveLength(0);
  });

  it("rejects bind_channel for an invalid platform format", async () => {
    const res = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: agentId,
      platform: "Slack!",
      channel_id: "C1",
    })) as { error?: string };
    expect(res.error).toMatch(/Invalid platform/);
  });

  it("get_channel_audience returns an audience list for the agent", async () => {
    const res = (await workspace.owner.connections.manage({
      action: "get_channel_audience",
      agent_id: agentId,
    })) as { agent_id?: string; audiences?: unknown[]; error?: string };
    expect(res.agent_id).toBe(agentId);
    expect(Array.isArray(res.audiences)).toBe(true);
  });

  it("get_channel_audience by connection_id tags each channel with its agent", async () => {
    const connId = await makeManagedSlackConnection({
      orgId,
      slug: "slackinst-aud",
      teamId: TEAM,
    });
    await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: agentId,
      platform: "slack",
      channel_id: "slack:CAUD",
      team_id: TEAM,
    });

    const res = (await workspace.owner.connections.manage({
      action: "get_channel_audience",
      connection_id: connId,
    })) as {
      connection_id?: number;
      audiences?: Array<{ channelId: string; agentId?: string | null }>;
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.connection_id).toBe(connId);
    const channel = res.audiences?.find((a) => a.channelId === "slack:CAUD");
    expect(channel).toBeDefined();
    // The connection-centric view tags the channel with the binding's agent.
    expect(channel?.agentId).toBe(agentId);
  });

  it("get_channel_audience requires exactly one of agent_id / connection_id", async () => {
    const res = (await workspace.owner.connections.manage({
      action: "get_channel_audience",
    })) as { error?: string };
    expect(res.error).toMatch(/exactly one/);
  });

  it("fences cross-org: an agent in another org is not reachable", async () => {
    const otherOrg = await createTestOrganization({ name: "Other Org" });
    const { agentId: foreignAgent } = await createTestAgent({
      organizationId: otherOrg.id,
    });
    const res = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: foreignAgent,
      platform: "slack",
      channel_id: "slack:CX",
      team_id: TEAM,
    })) as { error?: string };
    expect(res.error).toBe("Agent not found");
  });

  it("connect_channel_dm resolves the org-scoped bot token + canonical key", async () => {
    // Bot token: persisted under the install's org (PostgresSecretStore is
    // org-scoped via orgContext), referenced by the install metadata.
    const pg = new PostgresSecretStore();
    const store = new SecretStoreRegistry(pg, { secret: pg });
    const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
      persistSecretValue(store, "installations/slackinst-dm/botToken", "xoxb-test"),
    );

    const installStore = createPostgresAppInstallationStore();
    await installStore.upsert({
      provider: "slack",
      providerInstance: "default",
      providerAppId: "A_TEST",
      externalTenantId: TEAM,
      organizationId: orgId,
      status: "active",
      metadata: {
        external_id: "slackinst-dm",
        config: { botToken: tokenRef },
      },
    });

    // The caller's linked Slack identity (account row keyed by lobu user id).
    const sql = getTestDb();
    await sql`
      INSERT INTO account ("accountId", "providerId", "userId", id, "createdAt", "updatedAt")
      VALUES ('U_CALLER', 'slack', ${workspace.users.owner.id}, ${`acct_${Date.now()}`}, NOW(), NOW())
    `;

    let openedWith: { token: string; user: string } | null = null;
    __setSlackWebApiForTests({
      openDm: async (token, user) => {
        openedWith = { token, user };
        return "D999";
      },
      postMessage: async () => {},
    });

    const res = (await workspace.owner.connections.manage({
      action: "connect_channel_dm",
      agent_id: agentId,
      external_id: "slackinst-dm",
    })) as {
      success?: boolean;
      channel_id?: string;
      team_id?: string;
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.channel_id).toBe("D999");
    expect(res.team_id).toBe(TEAM);
    // The bot token was resolved (proves the orgContext wrap) and the caller's
    // Slack id used.
    expect(openedWith).toEqual({ token: "xoxb-test", user: "U_CALLER" });

    // Binding stored under the CANONICAL slack:<id> key (raw D… would not route).
    const bound = await getDb()`
      SELECT channel_id FROM agent_channel_bindings
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
    `;
    expect(bound.map((r) => r.channel_id)).toContain("slack:D999");
  });

  it("getBinding falls back to a team-less binding for BYO Slack, without leaking team-scoped ones", async () => {
    const sql = getTestDb();
    const svc = new ChannelBindingService();

    // BYO Slack: the channel is bound team-less (connection has no
    // external_tenant_id), but inbound Slack messages always carry a team_id.
    await sql`
      INSERT INTO agent_channel_bindings
        (organization_id, agent_id, platform, channel_id, team_id, created_at)
      VALUES (${orgId}, ${agentId}, 'slack', 'slack:C777', NULL, NOW())
    `;
    const found = await svc.getBinding("slack", "slack:C777", "TBYO", orgId);
    expect(found?.agentId).toBe(agentId);

    // Managed: a team-scoped binding matches exactly, and the fallback must NOT
    // hand it to a different workspace's message (no cross-tenant leak).
    await sql`
      INSERT INTO agent_channel_bindings
        (organization_id, agent_id, platform, channel_id, team_id, created_at)
      VALUES (${orgId}, ${agentId}, 'slack', 'slack:C888', 'TMANAGED', NOW())
    `;
    expect(
      (await svc.getBinding("slack", "slack:C888", "TMANAGED", orgId))?.agentId,
    ).toBe(agentId);
    expect(await svc.getBinding("slack", "slack:C888", "TOTHER", orgId)).toBeNull();
  });
});
