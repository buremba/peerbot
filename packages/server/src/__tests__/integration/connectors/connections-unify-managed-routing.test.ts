/**
 * Managed Slack OAuth install routing in the unified `connections` model.
 *
 *   1. A managed install (`slackinst-` slug, agent_id NULL) resolves its bound
 *      channels via the Behavior trigger's connection id — the legacy
 *      (org, agent, platform) tuple join never matched a NULL agent_id, so
 *      managed installs were invisible to ACL-sync / list / delivery.
 *   2. One-active-per-WORKSPACE for managed installs: a Slack team binds to
 *      exactly one org, so reinstalling the same team into a different org
 *      demotes the prior org's stale managed projection (no cross-org stale
 *      active routing/ACL row).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { resolveBoundChannelRows } from "../../../gateway/channels/bound-channels";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { upsertChatConnectionProjection } from "../../../lobu/stores/connections-projection";
import { upsertSlackInstallByTeam } from "../../../lobu/stores/slack-installations";
import { initWorkspaceProvider } from "../../../workspace";
import { createTestBehaviorSubscription } from "../../setup/behavior-subscriptions";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

function memorySecretStore() {
	const secrets = new Map<string, string>();
	const nameOf = (nameOrRef: string) =>
		nameOrRef.startsWith("secret://")
			? nameOrRef.slice("secret://".length)
			: nameOrRef;
	return {
		async get(ref: string) {
			return secrets.get(nameOf(ref)) ?? null;
		},
		async put(name: string, value: string) {
			secrets.set(name, value);
			return `secret://${name}`;
		},
		async delete(nameOrRef: string) {
			secrets.delete(nameOf(nameOrRef));
		},
		async list(prefix = "") {
			return [...secrets.keys()]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({
					ref: `secret://${name}`,
					backend: "memory",
					name,
					updatedAt: 0,
				}));
		},
	} as never;
}

describe("connections-unify managed-install routing", () => {
	let orgId: string;
	let orgB: string;
	let agentId: string;

	beforeAll(async () => {
		await initWorkspaceProvider();
		orgId = (await createTestOrganization()).id;
		orgB = (await createTestOrganization()).id;
		await createTestUser();
		agentId = (await createTestAgent({ organizationId: orgId })).agentId;
	}, 60_000);

	afterAll(async () => {
		const sql = getDb();
		await sql`DELETE FROM watchers WHERE organization_id IN (${orgId}, ${orgB})`;
		await sql`DELETE FROM connections WHERE organization_id IN (${orgId}, ${orgB})`;
		await sql`DELETE FROM app_installations WHERE organization_id IN (${orgId}, ${orgB})`;
	});

	it("resolves a managed install's bound channel via connection_id (agent_id NULL)", async () => {
		const sql = getDb();
		// A managed install: slackinst- slug, NO owning agent.
		const [conn] = (await sql`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, agent_id,
				display_name, status, config, credential_mode, slug, visibility
			) VALUES (
				${orgId}, 'slack', 'TMANAGED', NULL, 'Managed Co', 'active',
				${sql.json({ chatMetadata: { teamId: "TMANAGED" } })}, 'managed',
				'slackinst-mr-test', 'org'
			)
			RETURNING id
		`) as Array<{ id: number }>;

		// A binding linked to it by connection_id. agent_id is the LINKING agent
		// (non-null) — the legacy tuple join (b.agent_id = ac.agent_id) would fail
		// because the managed connection's agent_id is NULL; only the link resolves.
		await createTestBehaviorSubscription({
			organizationId: orgId,
			agentId,
			connectionId: Number(conn.id),
			platform: "slack",
			channelId: "slack:C-MANAGED",
			teamId: "TMANAGED",
		});

		const rows = await resolveBoundChannelRows(sql, {
			organizationId: orgId,
			connectionId: "slackinst-mr-test",
		});
		expect(rows.map((r) => r.channel_id)).toContain("slack:C-MANAGED");
		expect(rows.find((r) => r.channel_id === "slack:C-MANAGED")?.id).toBe(
			"slackinst-mr-test",
		);

		// AGENT-SCOPED paths (list_conversations / search) must
		// ALSO see it: the binding belongs to the agent that linked it, even though
		// the managed connection's own agent_id is NULL.
		const agentScoped = await resolveBoundChannelRows(sql, {
			organizationId: orgId,
			agentId,
		});
		expect(agentScoped.map((r) => r.channel_id)).toContain("slack:C-MANAGED");
	});

	it("reinstalling a team into another org demotes the prior org's managed projection", async () => {
		const db = getDb();
		const writeManaged = (org: string, id: string) =>
			db.begin(async (tx: typeof db) =>
				upsertChatConnectionProjection(
					tx,
					(v) => db.json(v),
					{
						id,
						platform: "slack",
						organizationId: org,
						config: { platform: "slack", botToken: `secret://${id}` },
						settings: {},
						metadata: { teamId: "TXFER" },
						status: "active",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					org,
					"managed",
				),
			);

		// Team TXFER installs into orgId, then transfers/reinstalls into orgB.
		await writeManaged(orgId, "slackinst-xfer-a");
		await writeManaged(orgB, "slackinst-xfer-b");

		const status = async (org: string, slug: string) => {
			const [r] = (await db`
				SELECT status FROM connections
				WHERE organization_id = ${org} AND slug = ${slug} AND deleted_at IS NULL
			`) as Array<{ status: string }>;
			return r?.status;
		};
		// Old org's managed install demoted; the new org owns the workspace.
		expect(await status(orgId, "slackinst-xfer-a")).toBe("paused");
		expect(await status(orgB, "slackinst-xfer-b")).toBe("active");
	});

	it("retires a stale org-wide (E…) connection when a per-workspace reinstall arrives", async () => {
		const db = getDb();
		const ENTERPRISE = "EGRIDSUP";
		const WORKSPACE = "TGRIDSUP";
		const secretStore = memorySecretStore();
		await db`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, display_name,
				status, config, credential_mode, slug, visibility
			) VALUES (
				${orgId}, 'slack', ${ENTERPRISE}, 'Stale Grid install',
				'active', '{}', 'managed', 'slackinst-grid-orphan', 'org'
			)
		`;
		const workspace = await upsertSlackInstallByTeam(
			createPostgresAppInstallationStore(),
			secretStore,
			orgId,
			WORKSPACE,
			{
				botToken: "xoxb-grid-test",
				enterpriseId: ENTERPRISE,
			},
		);

		const live = async (slug: string) => {
			const [r] = (await db`
				SELECT 1 FROM connections
				WHERE organization_id = ${orgId} AND slug = ${slug} AND deleted_at IS NULL
			`) as Array<unknown>;
			return r != null;
		};

		expect(await live(workspace.id)).toBe(true);
		expect(await live("slackinst-grid-orphan")).toBe(false);
	});

	it("carries the retired org-wide connection's fallback agent_id onto its per-workspace successor", async () => {
		// The E… generation owns the routing state an admin configured
		// (`manage_connections update agent_id`). Superseding it must not drop
		// that state on the floor: the T… row is a NEW slug, so it takes the
		// INSERT path and starts agent_id NULL. Without inheritance the workspace
		// comes up ownerless — resolveAgentId finds no connection owner, inbound
		// messages fall through to the unclaimed-workspace responder, and every
		// channel bound only by that fallback goes dark.
		const db = getDb();
		const ENTERPRISE = "EGRIDINHERIT";
		const WORKSPACE = "TGRIDINHERIT";
		const secretStore = memorySecretStore();
		await db`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, agent_id,
				display_name, status, config, credential_mode, slug, visibility
			) VALUES (
				${orgId}, 'slack', ${ENTERPRISE}, ${agentId}, 'Stale Grid install',
				'active', '{}', 'managed', 'slackinst-grid-inherit', 'org'
			)
		`;
		const workspace = await upsertSlackInstallByTeam(
			createPostgresAppInstallationStore(),
			secretStore,
			orgId,
			WORKSPACE,
			{ botToken: "xoxb-grid-test", enterpriseId: ENTERPRISE },
		);

		const [successor] = (await db`
			SELECT agent_id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${workspace.id}
				AND deleted_at IS NULL
		`) as Array<{ agent_id: string | null }>;
		expect(successor?.agent_id).toBe(agentId);
	});

	it("does not overwrite a successor's own fallback agent_id when superseding", async () => {
		// Inheritance fills a GAP; it never clobbers an explicit binding. If the
		// T… row already routes somewhere, the retiring E… row's stale agent
		// must not displace it.
		const db = getDb();
		const ENTERPRISE = "EGRIDNOCLOBBER";
		const WORKSPACE = "TGRIDNOCLOBBER";
		const secretStore = memorySecretStore();
		const install = () =>
			upsertSlackInstallByTeam(
				createPostgresAppInstallationStore(),
				secretStore,
				orgId,
				WORKSPACE,
				{ botToken: "xoxb-grid-test", enterpriseId: ENTERPRISE },
			);

		// The workspace connection exists first and carries its own routing.
		const workspace = await install();
		await db`
			UPDATE connections SET agent_id = ${agentId}
			WHERE organization_id = ${orgId} AND slug = ${workspace.id}
				AND deleted_at IS NULL
		`;
		// A stale org-wide generation pointing at a DIFFERENT agent shows up.
		const agentB = (await createTestAgent({ organizationId: orgId })).agentId;
		await db`
			INSERT INTO connections (
				organization_id, connector_key, external_tenant_id, agent_id,
				display_name, status, config, credential_mode, slug, visibility
			) VALUES (
				${orgId}, 'slack', ${ENTERPRISE}, ${agentB}, 'Stale Grid install',
				'active', '{}', 'managed', 'slackinst-grid-noclobber', 'org'
			)
		`;
		await install();

		const [successor] = (await db`
			SELECT agent_id FROM connections
			WHERE organization_id = ${orgId} AND slug = ${workspace.id}
				AND deleted_at IS NULL
		`) as Array<{ agent_id: string | null }>;
		expect(successor?.agent_id).toBe(agentId);
	});

	it("keeps an active org-wide Grid install when a workspace sibling is installed", async () => {
		const db = getDb();
		const enterpriseId = "EGRIDACTIVE";
		const secretStore = memorySecretStore();
		const install = (teamId: string, isEnterpriseInstall = false) =>
			upsertSlackInstallByTeam(
				createPostgresAppInstallationStore(),
				secretStore,
				orgId,
				teamId,
				{
					botToken: "xoxb-grid-test",
					enterpriseId,
					isEnterpriseInstall,
				},
			);

		const orgWide = await install(enterpriseId, true);
		const workspace = await install("TGRIDACTIVE");
		const live = await db<{ slug: string }[]>`
			SELECT slug FROM connections
			WHERE organization_id = ${orgId}
				AND slug IN (${orgWide.id}, ${workspace.id})
				AND deleted_at IS NULL AND status = 'active'
			ORDER BY slug
		`;

		expect(live.map((row) => row.slug)).toEqual(
			[orgWide.id, workspace.id].sort(),
		);
	});
});
