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
import { SLACK_IDENTITY, slackChannelKey } from "@lobu/connectors/slack-identity";
import { getDb } from "../../../db/client";
import {
	persistSecretValue,
	SecretStoreRegistry,
} from "../../../gateway/secrets";
import { orgContext } from "../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { ChannelBindingService } from "../../../gateway/channels/binding-service";
import { slugToRuntimeConnectionId } from "../../../lobu/stores/connections-projection";
import { __setBindChannelNotifyDepsForTests } from "../../../gateway/channels/bind-channel-notify";
import { __setBindingScopeResolverForTests } from "../../../gateway/channels/binding-scope-resolver";
import { resolveSlackBindingTeam } from "../../../gateway/connections/slack-binding-scope";
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
/** A Grid enterprise id (org-wide install tenant) — must NEVER reach a binding. */
const ENTERPRISE = "E0BDSKL1KJL";
/** The concrete workspace a Grid channel resolves to. */
const WORKSPACE = "T0BF8TKGW79";

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

	it("gates the per-binding model against the agent's exact models list", async () => {
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-modelgate",
			teamId: TEAM,
		});
		// Restrict the agent to exactly one model.
		const sql = getTestDb();
		await sql`
      UPDATE agents SET models = ${sql.json(["openai/gpt-5"])}
      WHERE organization_id = ${orgId} AND id = ${agentId}
    `;

		// An in-list model is accepted.
		const ok = (await workspace.owner.connections.manage({
			action: "bind_channel",
			agent_id: agentId,
			connection_id: connectionId,
			channel_id: "slack:CMODEL_OK",
			model: "openai/gpt-5",
		})) as { success?: boolean; error?: string };
		expect(ok.success).toBe(true);

		// A model NOT in the agent's list is rejected (same provider, diff model).
		const rejected = (await workspace.owner.connections.manage({
			action: "bind_channel",
			agent_id: agentId,
			connection_id: connectionId,
			channel_id: "slack:CMODEL_BAD",
			model: "openai/gpt-4o",
		})) as { success?: boolean; error?: string };
		expect(rejected.success).toBeUndefined();
		expect(String(rejected.error)).toContain("allowed models list");

		// "auto" is rejected outright (auto is gone repo-wide).
		const autoRejected = (await workspace.owner.connections.manage({
			action: "bind_channel",
			agent_id: agentId,
			connection_id: connectionId,
			channel_id: "slack:CMODEL_AUTO",
			model: "openai/auto",
		})) as { success?: boolean; error?: string };
		expect(autoRejected.success).toBeUndefined();
		expect(String(autoRejected.error)).toContain("auto");

		// Reset for later cases (beforeEach only clears bindings/connections).
		await sql`
      UPDATE agents SET models = NULL
      WHERE organization_id = ${orgId} AND id = ${agentId}
    `;
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

	it("bind_channel on an org-wide Grid install NEVER stores the enterprise id — stores the workspace T… from context_team_id", async () => {
		// An org-wide Grid install's connection tenant id is the ENTERPRISE id
		// (E…). The binding must carry the concrete WORKSPACE (T…), which the
		// connector resolver reads from conversations.info.context_team_id — never
		// the E….
		const pg = new PostgresSecretStore();
		const store = new SecretStoreRegistry(pg, { secret: pg });
		const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
			persistSecretValue(store, "installations/slackinst-grid/botToken", "xoxb-grid"),
		);
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-grid",
			teamId: ENTERPRISE, // org-wide install ⇒ tenant id is the enterprise E…
		});
		const sql = getTestDb();
		await sql`UPDATE connections SET config = ${sql.json({ botToken: tokenRef })} WHERE id = ${connectionId}`;

		// Drive the REAL Slack resolver with a stub Slack Web API + secret store so
		// the E… → conversations.info.context_team_id path is exercised end to end.
		__setBindingScopeResolverForTests("slack", (params) =>
			resolveSlackBindingTeam(
				{
					slackWeb: {
						conversationInfo: async () => ({
							name: "eng",
							isPrivate: false,
							contextTeamId: WORKSPACE,
						}),
					},
					secretStore: store,
				},
				params,
			),
		);
		try {
			const res = (await workspace.owner.connections.manage({
				action: "bind_channel",
				agent_id: agentId,
				connection_id: connectionId,
				channel_id: "slack:CGRID",
			})) as { success?: boolean; team_id?: string; error?: string };
			expect(res.error).toBeUndefined();
			expect(res.success).toBe(true);
			expect(res.team_id).toBe(WORKSPACE);
			expect(res.team_id).not.toBe(ENTERPRISE);

			const bound = await getDb()<{ team_id: string | null }[]>`
				SELECT team_id FROM agent_channel_bindings
				WHERE organization_id = ${orgId} AND channel_id = 'slack:CGRID'
			`;
			expect(bound[0]?.team_id).toBe(WORKSPACE);
			expect(bound[0]?.team_id).not.toBe(ENTERPRISE);
		} finally {
			__setBindingScopeResolverForTests("slack", undefined);
		}
	});

	it("bind_channel writes NULL (not the enterprise id) when the workspace is unresolvable yet", async () => {
		// Private channel the bot isn't in: conversations.info throws. The binding
		// gets a NULL team (unknown-yet, heals from inbound) — NEVER the E….
		const pg = new PostgresSecretStore();
		const store = new SecretStoreRegistry(pg, { secret: pg });
		const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
			persistSecretValue(store, "installations/slackinst-grid2/botToken", "xoxb-grid2"),
		);
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-grid2",
			teamId: ENTERPRISE,
		});
		const sql = getTestDb();
		await sql`UPDATE connections SET config = ${sql.json({ botToken: tokenRef })} WHERE id = ${connectionId}`;

		__setBindingScopeResolverForTests("slack", (params) =>
			resolveSlackBindingTeam(
				{
					slackWeb: {
						conversationInfo: async () => {
							throw new Error("Slack conversations.info failed: not_in_channel");
						},
					},
					secretStore: store,
				},
				params,
			),
		);
		try {
			const res = (await workspace.owner.connections.manage({
				action: "bind_channel",
				agent_id: agentId,
				connection_id: connectionId,
				channel_id: "slack:CPRIV",
			})) as { success?: boolean; team_id?: string; error?: string };
			expect(res.error).toBeUndefined();
			expect(res.success).toBe(true);
			expect(res.team_id).toBeUndefined();

			const bound = await getDb()<{ team_id: string | null }[]>`
				SELECT team_id FROM agent_channel_bindings
				WHERE organization_id = ${orgId} AND channel_id = 'slack:CPRIV'
			`;
			expect(bound[0]?.team_id).toBeNull();
		} finally {
			__setBindingScopeResolverForTests("slack", undefined);
		}
	});

	it("lazy self-heal: a NULL-team binding converges to the real T… after an inbound message", async () => {
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-heal",
			teamId: ENTERPRISE,
		});
		const sql = getTestDb();
		// A binding written before its workspace was known — NULL team.
		await sql`
			INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id)
			VALUES (${orgId}, ${agentId}, 'slack', 'slack:CHEAL', NULL, ${connectionId})
		`;
		const svc = new ChannelBindingService();
		// The inbound message carries the REAL workspace T…; heal converges to it.
		await svc.healBindingTeam(
			slugToRuntimeConnectionId("slackinst-heal"),
			"slack:CHEAL",
			orgId,
			WORKSPACE,
		);
		const healed = await getDb()<{ team_id: string | null }[]>`
			SELECT team_id FROM agent_channel_bindings
			WHERE organization_id = ${orgId} AND channel_id = 'slack:CHEAL'
		`;
		expect(healed[0]?.team_id).toBe(WORKSPACE);

		// Guard: a stray/foreign team on a later message must NOT overwrite a
		// known workspace.
		await svc.healBindingTeam(
			slugToRuntimeConnectionId("slackinst-heal"),
			"slack:CHEAL",
			orgId,
			"T99OTHER",
		);
		const after = await getDb()<{ team_id: string | null }[]>`
			SELECT team_id FROM agent_channel_bindings
			WHERE organization_id = ${orgId} AND channel_id = 'slack:CHEAL'
		`;
		expect(after[0]?.team_id).toBe(WORKSPACE);
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

	it("about edge on an org-wide Grid install keys the channel entity on the workspace T…, never the enterprise E…", async () => {
		// An org-wide Grid install's connection tenant id is the ENTERPRISE id (E…).
		// The channel-about edge must attach to the SAME channel resource entity the
		// binding + ACL graph own — keyed on the concrete workspace T…, resolved from
		// conversations.info.context_team_id — NOT a phantom E…:C… entity.
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
			name: "Grid Acme",
			entity_type: "company",
			organization_id: orgId,
			created_by: user.id,
		});

		const pg = new PostgresSecretStore();
		const store = new SecretStoreRegistry(pg, { secret: pg });
		const tokenRef = await orgContext.run({ organizationId: orgId }, () =>
			persistSecretValue(
				store,
				"installations/slackinst-gridabout/botToken",
				"xoxb-gridabout",
			),
		);
		const connectionId = await makeManagedSlackConnection({
			orgId,
			slug: "slackinst-gridabout",
			teamId: ENTERPRISE, // org-wide install ⇒ tenant id is the enterprise E…
		});
		await sql`UPDATE connections SET config = ${sql.json({ botToken: tokenRef })} WHERE id = ${connectionId}`;

		// The channel lives in workspace WORKSPACE (T…) — the resolver reads it from
		// conversations.info.context_team_id. Bind with a BARE channel id (no T…/
		// prefix hint) so resolution goes through the E… → context_team_id path.
		__setBindingScopeResolverForTests("slack", (params) =>
			resolveSlackBindingTeam(
				{
					slackWeb: {
						conversationInfo: async () => ({
							name: "eng",
							isPrivate: false,
							contextTeamId: WORKSPACE,
						}),
					},
					secretStore: store,
				},
				params,
			),
		);
		try {
			const synced = (await workspace.owner.connections.manage({
				action: "sync_channel_bindings",
				agent_id: agentId,
				connection_id: connectionId,
				channels: [{ channel_id: "slack:CGRIDABOUT", about: ["grid-acme"] }],
			})) as { success?: boolean; about_linked?: number; error?: string };
			expect(synced.error).toBeUndefined();
			expect(synced.success).toBe(true);
			expect(synced.about_linked).toBe(1);

			// The channel resource entity the edge points FROM must be identified on
			// the workspace key T…:C…, and NO enterprise-keyed E…:C… entity exists.
			const workspaceKey = slackChannelKey(WORKSPACE, "CGRIDABOUT");
			const enterpriseKey = slackChannelKey(ENTERPRISE, "CGRIDABOUT");
			const [wsEntity] = await sql<{ entity_id: number }[]>`
        SELECT entity_id FROM entity_identities
        WHERE organization_id = ${orgId}
          AND namespace = ${SLACK_IDENTITY.CHANNEL_ID}
          AND identifier = ${workspaceKey}
          AND deleted_at IS NULL
      `;
			expect(wsEntity?.entity_id).toBeDefined();
			const entEntity = await sql<{ entity_id: number }[]>`
        SELECT entity_id FROM entity_identities
        WHERE organization_id = ${orgId}
          AND namespace = ${SLACK_IDENTITY.CHANNEL_ID}
          AND identifier = ${enterpriseKey}
          AND deleted_at IS NULL
      `;
			expect(entEntity).toHaveLength(0);

			const edges = await sql<
				{ from_entity_id: number; to_entity_id: number; channel_key: string }[]
			>`
        SELECT r.from_entity_id, r.to_entity_id, r.metadata->>'channel_key' AS channel_key
        FROM entity_relationships r
        JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
        WHERE r.organization_id = ${orgId}
          AND rt.slug = 'about'
          AND r.deleted_at IS NULL
          AND r.metadata->>'connection_id' = ${String(connectionId)}
      `;
			expect(edges).toHaveLength(1);
			expect(Number(edges[0].to_entity_id)).toBe(company.id);
			// The edge attaches to the WORKSPACE-keyed channel entity, not the E… one.
			expect(Number(edges[0].from_entity_id)).toBe(Number(wsEntity.entity_id));
			expect(edges[0].channel_key).toBe(workspaceKey);
			expect(edges[0].channel_key).not.toContain(ENTERPRISE);
		} finally {
			__setBindingScopeResolverForTests("slack", undefined);
		}
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
