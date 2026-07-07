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

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../../db/client";
import {
	persistSecretValue,
	SecretStoreRegistry,
} from "../../../gateway/secrets";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { __setBindChannelNotifyDepsForTests } from "../../../gateway/channels/bind-channel-notify";
import { __setSlackWebApiForTests } from "../../../tools/admin/manage_connections/handlers/channel-bindings";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestAccessToken,
	createTestConnection,
	createTestEntity,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestMcpClient, TestWorkspace } from "../../setup/test-mcp-client";

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
	let mcpClient: TestMcpClient;
	let orgId: string;
	let agentId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({ name: "Channel Actions Org" });
		orgId = workspace.org.id;
		const oauthClient = await createTestOAuthClient();
		const oauthResult = await createTestAccessToken(
			workspace.users.owner.id,
			orgId,
			oauthClient.client_id,
		);
		mcpClient = new TestMcpClient({
			token: oauthResult.token,
			orgSlug: workspace.org.slug,
		});
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
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => false,
			getManager: () => null,
		});
	});

	it("bind_channel schedules a generic channel confirmation when the gateway is up", async () => {
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-notify",
			teamId: TEAM,
		});
		const postMessageToChannel = vi.fn(async () => {});
		__setBindChannelNotifyDepsForTests({
			gatewayRunning: () => true,
			getManager: () => ({ postMessageToChannel }),
		});

		const bound = (await workspace.owner.connections.manage({
			action: "bind_channel",
			agent_id: agentId,
			connection_id: connectionId,
			channel_id: "slack:C222",
		})) as { success?: boolean };
		expect(bound.success).toBe(true);
		expect(postMessageToChannel).toHaveBeenCalledTimes(1);
		expect(postMessageToChannel).toHaveBeenCalledWith(
			"slackinst-notify",
			"slack:C222",
			expect.objectContaining({
				markdown: expect.stringContaining("Linked to"),
			}),
		);

		await workspace.owner.connections.manage({
			action: "bind_channel",
			agent_id: agentId,
			connection_id: connectionId,
			channel_id: "slack:C222",
		});
		expect(postMessageToChannel).toHaveBeenCalledTimes(1);
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

	it("sync_channel_bindings writes config-sourced about edges from entity slugs", async () => {
		const user = await createTestUser();
		await addUserToOrganization(user.id, orgId, "owner");
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'company', 'Company', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
		const company = await createTestEntity({
			name: "Acme",
			entity_type: "company",
			organization_id: orgId,
			created_by: user.id,
		});
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-about",
			teamId: TEAM,
		});

		const synced = (await workspace.owner.connections.manage({
			action: "sync_channel_bindings",
			agent_id: agentId,
			connection_id: connectionId,
			channels: [
				{
					channel_id: `${TEAM}/CABOUT`,
					about: ["acme"],
				},
			],
		})) as { success?: boolean; about_linked?: number; error?: string };
		expect(synced.error).toBeUndefined();
		expect(synced.success).toBe(true);
		expect(synced.about_linked).toBe(1);

		const edges = await sql<{ to_entity_id: number; source: string | null }[]>`
      SELECT r.to_entity_id, r.source
      FROM entity_relationships r
      JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
      WHERE r.organization_id = ${orgId}
        AND rt.slug = 'about'
        AND r.deleted_at IS NULL
    `;
		expect(edges).toHaveLength(1);
		expect(Number(edges[0].to_entity_id)).toBe(company.id);
		expect(edges[0].source).toBe("config");
	});

	it("surfaces about-linked channels in entity_names and active_connections", async () => {
		const user = await createTestUser();
		await addUserToOrganization(user.id, orgId, "owner");
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'company', 'Company', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
		const customer = await createTestEntity({
			name: "Acme Customer",
			entity_type: "company",
			organization_id: orgId,
			created_by: user.id,
		});
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-customer-context",
			teamId: TEAM,
		});

		const synced = (await workspace.owner.connections.manage({
			action: "sync_channel_bindings",
			agent_id: agentId,
			connection_id: connectionId,
			channels: [
				{
					channel_id: `${TEAM}/CCUST`,
					about: ["acme-customer"],
				},
			],
		})) as { success?: boolean; error?: string };
		expect(synced.error).toBeUndefined();
		expect(synced.success).toBe(true);

		const listed = (await workspace.owner.connections.manage({
			action: "list",
			entity_id: customer.id,
		})) as {
			connections?: Array<{ id: number; entity_names?: string | null }>;
		};
		const match = listed.connections?.find((c) => c.id === connectionId);
		expect(match).toBeDefined();
		expect(match?.entity_names ?? "").toContain("Acme Customer");

		const resolved = (await mcpClient.resolvePath(
			`/${workspace.org.slug}/company/acme-customer`,
		)) as { entity?: { active_connections?: number } };
		expect(resolved.entity?.active_connections ?? 0).toBeGreaterThanOrEqual(1);
	});
});
