/**
 * Managed Slack OAuth install routing in the unified `connections` model.
 *
 *   1. A managed install (`slackinst-` slug, agent_id NULL) resolves its bound
 *      channels via the `agent_channel_bindings.connection_id` link — the legacy
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
import { upsertChatConnectionProjection } from "../../../lobu/stores/connections-projection";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

describe("connections-unify managed-install routing", () => {
	let orgId: string;
	let orgB: string;
	let agentId: string;

	beforeAll(async () => {
		await initWorkspaceProvider();
		orgId = (await createTestOrganization()).id;
		orgB = (await createTestOrganization()).id;
		agentId = (await createTestAgent({ organizationId: orgId })).agentId;
	}, 60_000);

	afterAll(async () => {
		const sql = getDb();
		await sql`DELETE FROM agent_channel_bindings WHERE organization_id IN (${orgId}, ${orgB})`;
		await sql`DELETE FROM connections WHERE organization_id IN (${orgId}, ${orgB})`;
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
		await sql`
			INSERT INTO agent_channel_bindings
				(organization_id, agent_id, platform, channel_id, team_id, connection_id)
			VALUES (${orgId}, ${agentId}, 'slack', 'slack:C-MANAGED', 'TMANAGED', ${conn.id})
		`;

		const rows = await resolveBoundChannelRows(sql, {
			organizationId: orgId,
			connectionId: "slackinst-mr-test",
		});
		expect(rows.map((r) => r.channel_id)).toContain("slack:C-MANAGED");
		expect(rows.find((r) => r.channel_id === "slack:C-MANAGED")?.id).toBe(
			"slackinst-mr-test",
		);

		// AGENT-SCOPED paths (list_conversations / search / channel-audience) must
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
});
