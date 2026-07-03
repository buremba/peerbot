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
import {
	persistSecretValue,
	SecretStoreRegistry,
} from "../../../gateway/secrets";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
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
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-rt",
			teamId: TEAM,
		});

    const bound = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: agentId,
			connection_id: connectionId,
      channel_id: "slack:C111",
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
			connection_id: connectionId,
      channel_id: "slack:C111",
    })) as { success?: boolean };
    expect(unbound.success).toBe(true);

    const after = (await workspace.owner.connections.manage({
      action: "list_channel_bindings",
      agent_id: agentId,
    })) as { bindings: unknown[] };
    expect(after.bindings).toHaveLength(0);
  });

	it("rejects bind_channel for a missing connection", async () => {
    const res = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: agentId,
			connection_id: 999999,
      channel_id: "C1",
    })) as { error?: string };
		expect(res.error).toMatch(/connection not found/i);
  });

	it("fences cross-org: an agent in another org is not reachable", async () => {
		const connectionId = await makeManagedSlackConnection({
      orgId,
			slug: "slackinst-fence",
      teamId: TEAM,
    });
    const otherOrg = await createTestOrganization({ name: "Other Org" });
    const { agentId: foreignAgent } = await createTestAgent({
      organizationId: otherOrg.id,
    });
    const res = (await workspace.owner.connections.manage({
      action: "bind_channel",
      agent_id: foreignAgent,
			connection_id: connectionId,
      channel_id: "slack:CX",
    })) as { error?: string };
    expect(res.error).toBe("Agent not found");
  });

  it("connect_channel_dm resolves the org-scoped bot token + canonical key", async () => {
    // Bot token: persisted under the install's org (PostgresSecretStore is
    // org-scoped via orgContext), referenced by the install metadata.
    const pg = new PostgresSecretStore();
    const store = new SecretStoreRegistry(pg, { secret: pg });
    const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
			persistSecretValue(
				store,
				"installations/slackinst-dm/botToken",
				"xoxb-test",
			),
    );

		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-dm",
			teamId: TEAM,
    });
		const sql = getTestDb();
		await sql`UPDATE connections SET config = ${sql.json({ botToken: tokenRef })} WHERE id = ${connectionId}`;

    // The caller's linked Slack identity (account row keyed by lobu user id).
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
			connection_id: connectionId,
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
});
