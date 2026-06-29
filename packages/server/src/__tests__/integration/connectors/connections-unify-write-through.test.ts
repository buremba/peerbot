/**
 * Connections-unify Stage 2a — dual-write-through + read cutover.
 *
 * Stage 1 backfilled a one-time `connections` projection. Stage 2a repoints the
 * chat runtime to READ that projection (preferring it, falling back to the
 * legacy tables on a miss) and keeps it live by WRITING through every chat write
 * to BOTH the legacy table and the `connections` row, in one transaction.
 *
 * These tests drive the real Postgres `AgentConnectionStore` (BYO) and the Slack
 * install path (managed) against `lobu_test`, proving:
 *   1. saveConnection writes both sources; getConnection reads the projection
 *      (id preserved, config un-folded, tenant lifted, status mapped);
 *   2. updateConnection edits are reflected on read AND bump connections.updated_at,
 *      with both sources holding the SAME post-write state (no divergence);
 *   3. a stop write maps to paused→stopped; delete soft-deletes the projection;
 *   4. listConnections prefers the projection and unions un-projected legacy rows;
 *   5. one-active-per-tenant: a second active BYO slack save demotes the first;
 *   6. the managed Slack install path projects a credential_mode=managed row that
 *      getConnection resolves by its slackinst- id.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { SecretStoreRegistry } from "../../../gateway/secrets/index";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { upsertChatConnectionProjection } from "../../../lobu/stores/connections-projection";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { orgContext } from "../../../lobu/stores/org-context";
import { upsertSlackInstallByTeam } from "../../../lobu/stores/slack-installations";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

const ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const store = createPostgresAgentConnectionStore();

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
	return orgContext.run({ organizationId: orgId }, fn);
}

interface ProjRow {
	slug: string;
	connector_key: string;
	status: string;
	credential_mode: string | null;
	external_tenant_id: string | null;
	config: Record<string, any> | null;
	deleted_at: string | null;
	updated_at: string;
}

async function projBySlug(orgId: string, slug: string): Promise<ProjRow | null> {
	const rows = (await getDb()`
		SELECT slug, connector_key, status, credential_mode, external_tenant_id,
		       config, deleted_at, updated_at
		FROM connections
		WHERE organization_id = ${orgId} AND slug = ${slug}
	`) as unknown as ProjRow[];
	return rows[0] ?? null;
}

describe("connections-unify Stage 2a write-through + read cutover", () => {
	let orgId: string;
	let agentId: string;

	beforeAll(async () => {
		process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
		await initWorkspaceProvider();
		orgId = (await createTestOrganization()).id;
		agentId = (await createTestAgent({ organizationId: orgId })).agentId;
	}, 60_000);

	afterAll(async () => {
		const sql = getDb();
		await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
		await sql`DELETE FROM agent_connections WHERE organization_id = ${orgId}`;
		await sql`DELETE FROM app_installations WHERE organization_id = ${orgId}`;
	});

	it("saveConnection writes both sources; read resolves from the projection", async () => {
		await withOrg(orgId, () =>
			store.saveConnection({
				id: "wt-slack-1",
				platform: "slack",
				agentId,
				organizationId: orgId,
				config: { platform: "slack", botToken: "secret://wt-1" },
				settings: { allowGroups: true },
				metadata: { teamId: "TW1", teamName: "Wt One" },
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		// Projection row exists, byo, tenant lifted into the column, config folded.
		const proj = await projBySlug(orgId, "agentconn-wt-slack-1");
		expect(proj?.credential_mode).toBe("byo");
		expect(proj?.connector_key).toBe("slack");
		expect(proj?.status).toBe("active");
		expect(proj?.external_tenant_id).toBe("TW1");
		expect(proj?.config?.botToken).toBe("secret://wt-1");
		expect(
			(proj?.config?.chatMetadata as Record<string, unknown>)?.teamId,
		).toBe("TW1");

		// Legacy row also written (durable source).
		const [legacy] = (await getDb()`
			SELECT status FROM agent_connections WHERE id = 'wt-slack-1'
		`) as Array<{ status: string }>;
		expect(legacy.status).toBe("active");

		// Read resolves from the projection: id PRESERVED (not the bigint PK),
		// config un-folded, settings/metadata restored, status mapped.
		const read = await withOrg(orgId, () => store.getConnection("wt-slack-1"));
		expect(read?.id).toBe("wt-slack-1");
		expect(read?.platform).toBe("slack");
		expect(read?.config).toEqual({ platform: "slack", botToken: "secret://wt-1" });
		expect(read?.settings).toEqual({ allowGroups: true });
		expect(read?.metadata?.teamId).toBe("TW1");
		expect(read?.status).toBe("active");
	});

	it("updateConnection reflects the edit, bumps connections.updated_at, keeps both sources in sync", async () => {
		const before = await projBySlug(orgId, "agentconn-wt-slack-1");
		await new Promise((r) => setTimeout(r, 10));

		await withOrg(orgId, () =>
			store.updateConnection("wt-slack-1", {
				config: { platform: "slack", botToken: "secret://wt-1-rotated" },
			}),
		);

		// Read reflects the edit (proves no stale projection).
		const read = await withOrg(orgId, () => store.getConnection("wt-slack-1"));
		expect((read?.config as Record<string, unknown>)?.botToken).toBe(
			"secret://wt-1-rotated",
		);

		// connections.updated_at bumped (memo invalidation under multi-replica).
		const after = await projBySlug(orgId, "agentconn-wt-slack-1");
		expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
			new Date(before!.updated_at).getTime(),
		);

		// No divergence: both sources hold the same post-write token.
		expect(after?.config?.botToken).toBe("secret://wt-1-rotated");
		const [legacy] = (await getDb()`
			SELECT config FROM agent_connections WHERE id = 'wt-slack-1'
		`) as Array<{ config: Record<string, any> }>;
		expect(legacy.config.botToken).toBe("secret://wt-1-rotated");
	});

	it("a stop write maps paused→stopped on read", async () => {
		await withOrg(orgId, () =>
			store.updateConnection("wt-slack-1", { status: "stopped" }),
		);
		const proj = await projBySlug(orgId, "agentconn-wt-slack-1");
		expect(proj?.status).toBe("paused"); // connections has no 'stopped'
		const read = await withOrg(orgId, () => store.getConnection("wt-slack-1"));
		expect(read?.status).toBe("stopped"); // mapped back for the runtime
	});

	it("falls back to legacy agent_connections when no projection exists", async () => {
		// Seed a legacy-only row (no projection) — simulates a pre-deploy row.
		await getDb()`
			INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status, created_at, updated_at)
			VALUES ('wt-legacy-only', ${orgId}, ${agentId}, 'telegram',
			        ${getDb().json({ platform: "telegram", botToken: "secret://leg" })},
			        ${getDb().json({ allowGroups: true })}, ${getDb().json({})},
			        'active', now(), now())
		`;
		const read = await withOrg(orgId, () =>
			store.getConnection("wt-legacy-only"),
		);
		expect(read?.id).toBe("wt-legacy-only");
		expect(read?.platform).toBe("telegram");
		expect(read?.status).toBe("active");

		// listConnections unions the un-projected legacy row in (deference by slug).
		const list = await withOrg(orgId, () =>
			store.listConnections({ agentId }),
		);
		const ids = list.map((c) => c.id);
		expect(ids).toContain("wt-legacy-only"); // legacy union
		expect(ids).toContain("wt-slack-1"); // projection
	});

	it("deleteConnection hard-deletes legacy and soft-deletes the projection", async () => {
		await withOrg(orgId, () => store.deleteConnection("wt-slack-1"));
		const [legacy] = (await getDb()`
			SELECT 1 FROM agent_connections WHERE id = 'wt-slack-1'
		`) as unknown[];
		expect(legacy).toBeUndefined();
		const proj = await projBySlug(orgId, "agentconn-wt-slack-1");
		expect(proj?.deleted_at).not.toBeNull();
		const read = await withOrg(orgId, () => store.getConnection("wt-slack-1"));
		expect(read).toBeNull();
	});

	it("one-active-per-tenant: a second active projection write demotes the first sibling", async () => {
		// Drive the projection writer directly: two DIFFERENT chat connections
		// (distinct slugs) contending for the same (org, slack, tenant). The legacy
		// agent_connections table has its own one-slack-per-workspace constraint, so
		// the cross-source (BYO↔managed) contention this demote resolves is only
		// reachable at the connections layer — exercise it there.
		const db = getDb();
		const writeActive = (id: string) =>
			db.begin(async (tx: typeof db) =>
				upsertChatConnectionProjection(
					tx,
					(v) => db.json(v),
					{
						id,
						platform: "slack",
						organizationId: orgId,
						config: { platform: "slack", botToken: `secret://${id}` },
						settings: { allowGroups: true },
						metadata: { teamId: "TDEMO" },
						status: "active",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					orgId,
					"byo",
				),
			);
		await writeActive("wt-demo-a");
		await writeActive("wt-demo-b");

		const a = await projBySlug(orgId, "agentconn-wt-demo-a");
		const b = await projBySlug(orgId, "agentconn-wt-demo-b");
		expect(b?.status).toBe("active"); // last writer wins the tenant slot
		expect(a?.status).toBe("paused"); // prior active demoted

		const [{ count }] = (await getDb()`
			SELECT COUNT(*)::int AS count FROM connections
			WHERE organization_id = ${orgId} AND connector_key = 'slack'
			  AND external_tenant_id = 'TDEMO' AND status = 'active' AND deleted_at IS NULL
		`) as Array<{ count: number }>;
		expect(Number(count)).toBe(1);
	});

	it("managed Slack install projects a credential_mode=managed row resolvable by its slackinst- id", async () => {
		const pss = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(pss, { secret: pss });
		const installStore = createPostgresAppInstallationStore();

		const row = await upsertSlackInstallByTeam(
			installStore,
			secretStore,
			orgId,
			"TMGD",
			{ teamName: "Managed Co", botUserId: "U999", botToken: "xoxb-managed" },
		);
		expect(row.id.startsWith("slackinst-")).toBe(true);

		// Projection mirrors the install (managed, tenant lifted, active).
		const proj = await projBySlug(orgId, row.id);
		expect(proj?.credential_mode).toBe("managed");
		expect(proj?.connector_key).toBe("slack");
		expect(proj?.external_tenant_id).toBe("TMGD");
		expect(proj?.status).toBe("active");

		// The store resolves it by the slackinst- id (slug = id verbatim).
		const read = await withOrg(orgId, () => store.getConnection(row.id));
		expect(read?.id).toBe(row.id);
		expect(read?.platform).toBe("slack");
		expect(read?.metadata?.teamId).toBe("TMGD");
		expect(read?.status).toBe("active");
	});
});
