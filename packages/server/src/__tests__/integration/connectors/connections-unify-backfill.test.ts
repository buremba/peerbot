/**
 * Connections-unify Stage 1 — reuse-first expand/backfill migration.
 *
 * Proves the idempotent backfill (20260629000030_connections_unify_backfill.sql)
 * folds the two out-of-table chat stores into the unified `connections` table
 * using EXISTING columns plus the one new `credential_mode`:
 *   1. existing data connectors are left untouched (credential_mode NULL);
 *   2. agent_connections chat rows become credential_mode='byo' connections —
 *      connector_key=platform, tenant in config->>'teamId', token kept in config,
 *      agent_id carried, slug='agentconn-'||id;
 *   3. slack app_installations become credential_mode='managed' connections —
 *      connector_key='slack', app_auth_profile_id from the install, slug=external_id;
 *   4. BYO-WINS: a BYO row and a managed install contending for the same
 *      (org, platform, team) → BYO holds 'active', managed demoted to 'paused';
 *   5. existing agent_channel_bindings get connection_id linked (by team, or by
 *      agent for tenantless platforms);
 *   6. re-running the backfill is a no-op (idempotency, keyed on the unique slug).
 *
 * The test seeds rows on `lobu_test` (scoped to a fresh org) and executes the
 * migration's `-- migrate:up` body verbatim — the same SQL prod runs — so it
 * can't drift from what ships.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { loadMigrationUpSection } from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestAgent,
	createTestConnection,
	createTestOrganization,
} from "../../setup/test-fixtures";

const BACKFILL_MIGRATION = "20260629000030_connections_unify_backfill.sql";

function resolveMigrationsDir(): string {
	let dir = __dirname;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "db/migrations");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not locate db/migrations from the test directory");
}

/** Run the backfill migration's up-section verbatim (the SQL prod applies). */
async function runBackfill(): Promise<void> {
	const upSection = loadMigrationUpSection(
		resolveMigrationsDir(),
		BACKFILL_MIGRATION,
	);
	await getDb().unsafe(upSection);
}

interface ConnRow {
	id: string;
	connector_key: string;
	status: string;
	credential_mode: string | null;
	external_tenant_id: string | null;
	app_auth_profile_id: string | null;
	agent_id: string | null;
	slug: string;
	config: Record<string, unknown> | null;
}

/** A backfilled connection by its (org-unique) slug. */
async function connBySlug(orgId: string, slug: string): Promise<ConnRow | null> {
	const rows = (await getDb()`
		SELECT id, connector_key, status, credential_mode, external_tenant_id,
		       app_auth_profile_id, agent_id, slug, config
		FROM connections
		WHERE organization_id = ${orgId} AND slug = ${slug}
	`) as unknown as ConnRow[];
	return rows[0] ? { ...rows[0], id: String(rows[0].id) } : null;
}

async function chatConnCount(orgId: string): Promise<number> {
	const [{ count }] = (await getDb()`
		SELECT COUNT(*)::int AS count FROM connections
		WHERE organization_id = ${orgId} AND credential_mode IS NOT NULL
	`) as Array<{ count: number }>;
	return Number(count);
}

describe("connections-unify Stage 1 backfill (reuse-first)", () => {
	let orgId: string;
	let agentA: string;
	let dataConnectionId: number;

	beforeAll(async () => {
		await initWorkspaceProvider();
		const sql = getDb();

		const org = await createTestOrganization();
		orgId = org.id;
		agentA = (await createTestAgent({ organizationId: orgId })).agentId;

		// (1) an existing data connector — must be left untouched (mode NULL).
		dataConnectionId = (
			await createTestConnection({
				organization_id: orgId,
				connector_key: "github",
				createDefaultFeed: false,
			})
		).id;

		// (2) BYO Slack for team T1 — will WIN the T1 slot over the managed install.
		await insertAgentConnection(sql, {
			id: "ac-slack-t1",
			orgId,
			agentId: agentA,
			platform: "slack",
			metadata: { teamId: "T1", teamName: "Acme" },
			settings: { previewMode: false },
			config: { platform: "slack", botToken: "secret://byo-t1" },
			status: "active",
			updatedAt: "2026-06-01T00:00:00Z",
		});

		// (3) Telegram BYO (tenantless) — config.teamId NULL.
		await insertAgentConnection(sql, {
			id: "ac-tg-a",
			orgId,
			agentId: agentA,
			platform: "telegram",
			metadata: {},
			settings: {},
			config: { platform: "telegram", botToken: "secret://tg" },
			status: "active",
			updatedAt: "2026-06-01T00:00:00Z",
		});

		// (4) Managed Slack install for T1 (contended → demoted to paused).
		await insertAppInstallation(sql, {
			orgId,
			externalTenantId: "T1",
			status: "active",
			metadata: {
				external_id: "slackinst-t1",
				team_name: "Acme",
				config: { platform: "slack", botToken: "secret://mgd-t1" },
			},
		});
		// (4b) Managed Slack install for T2 (uncontended → stays active).
		await insertAppInstallation(sql, {
			orgId,
			externalTenantId: "T2",
			status: "active",
			metadata: {
				external_id: "slackinst-t2",
				team_name: "Beta",
				config: { platform: "slack", botToken: "secret://mgd-t2" },
			},
		});

		// (5) Bindings to link.
		await insertBinding(sql, {
			orgId,
			agentId: agentA,
			platform: "slack",
			channelId: "C1",
			teamId: "T1",
		});
		await insertBinding(sql, {
			orgId,
			agentId: agentA,
			platform: "telegram",
			channelId: "C2",
			teamId: null,
		});

		await runBackfill();
	});

	afterAll(async () => {
		const sql = getDb();
		await sql`DELETE FROM agent_channel_bindings WHERE organization_id = ${orgId}`;
		await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
		await sql`DELETE FROM agent_connections WHERE organization_id = ${orgId}`;
		await sql`DELETE FROM app_installations WHERE organization_id = ${orgId}`;
	});

	it("leaves existing data connectors untouched (credential_mode NULL)", async () => {
		const [row] = (await getDb()`
			SELECT credential_mode FROM connections WHERE id = ${dataConnectionId}
		`) as Array<{ credential_mode: string | null }>;
		expect(row.credential_mode).toBeNull();
	});

	it("folds BYO slack into a credential_mode=byo connection (tenant column)", async () => {
		const row = await connBySlug(orgId, "agentconn-ac-slack-t1");
		expect(row).toBeTruthy();
		expect(row!.credential_mode).toBe("byo");
		expect(row!.connector_key).toBe("slack");
		expect(row!.status).toBe("active");
		expect(row!.external_tenant_id).toBe("T1");
		expect(row!.config?.botToken).toBe("secret://byo-t1");
		// settings folded into config losslessly.
		expect((row!.config?.settings as Record<string, unknown>)?.previewMode).toBe(
			false,
		);
		expect(row!.agent_id).toBe(agentA);
	});

	it("folds telegram BYO as tenantless chat (external_tenant_id NULL)", async () => {
		const row = await connBySlug(orgId, "agentconn-ac-tg-a");
		expect(row!.credential_mode).toBe("byo");
		expect(row!.connector_key).toBe("telegram");
		expect(row!.status).toBe("active");
		expect(row!.external_tenant_id).toBeNull();
		expect(row!.agent_id).toBe(agentA);
	});

	it("BYO wins over a managed install for the same team (managed → paused)", async () => {
		const managed = await connBySlug(orgId, "slackinst-t1");
		expect(managed!.credential_mode).toBe("managed");
		expect(managed!.external_tenant_id).toBe("T1");
		expect(managed!.status).toBe("paused");
		// app_auth_profile_id reuses the install's auth_profile_id (NULL for slack).
		expect(managed!.app_auth_profile_id).toBeNull();

		// Exactly one ACTIVE chat connection for (org, slack, T1).
		const [{ count }] = (await getDb()`
			SELECT COUNT(*)::int AS count FROM connections
			WHERE organization_id = ${orgId} AND connector_key = 'slack'
			  AND external_tenant_id = 'T1' AND status = 'active' AND deleted_at IS NULL
		`) as Array<{ count: number }>;
		expect(Number(count)).toBe(1);
	});

	it("keeps an uncontended managed install active", async () => {
		const managed = await connBySlug(orgId, "slackinst-t2");
		expect(managed!.credential_mode).toBe("managed");
		expect(managed!.status).toBe("active");
		expect(managed!.external_tenant_id).toBe("T2");
	});

	it("links existing bindings to the active backfilled chat connection", async () => {
		const byoT1 = await connBySlug(orgId, "agentconn-ac-slack-t1");
		const telegram = await connBySlug(orgId, "agentconn-ac-tg-a");

		const [slackBinding] = (await getDb()`
			SELECT connection_id FROM agent_channel_bindings
			WHERE organization_id = ${orgId} AND platform = 'slack' AND channel_id = 'C1'
		`) as Array<{ connection_id: string | null }>;
		expect(String(slackBinding.connection_id)).toBe(byoT1!.id);

		const [tgBinding] = (await getDb()`
			SELECT connection_id FROM agent_channel_bindings
			WHERE organization_id = ${orgId} AND platform = 'telegram' AND channel_id = 'C2'
		`) as Array<{ connection_id: string | null }>;
		expect(String(tgBinding.connection_id)).toBe(telegram!.id);
	});

	it("is idempotent — re-running inserts no duplicates", async () => {
		const before = await chatConnCount(orgId);
		await runBackfill();
		const after = await chatConnCount(orgId);
		expect(after).toBe(before);
	});
});

// ── seed helpers ────────────────────────────────────────────────────────────

async function insertAgentConnection(
	sql: ReturnType<typeof getDb>,
	opts: {
		id: string;
		orgId: string;
		agentId: string;
		platform: string;
		metadata: Record<string, unknown>;
		settings: Record<string, unknown>;
		config: Record<string, unknown>;
		status: string;
		updatedAt: string;
	},
): Promise<void> {
	await sql`
		INSERT INTO agent_connections (
			id, organization_id, agent_id, platform, config, settings, metadata,
			status, created_at, updated_at
		) VALUES (
			${opts.id}, ${opts.orgId}, ${opts.agentId}, ${opts.platform},
			${sql.json(opts.config)}, ${sql.json(opts.settings)}, ${sql.json(opts.metadata)},
			${opts.status}, ${opts.updatedAt}, ${opts.updatedAt}
		)
	`;
}

async function insertAppInstallation(
	sql: ReturnType<typeof getDb>,
	opts: {
		orgId: string;
		externalTenantId: string;
		status: string;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	await sql`
		INSERT INTO app_installations (
			organization_id, provider, provider_instance, provider_app_id,
			external_tenant_id, status, metadata
		) VALUES (
			${opts.orgId}, 'slack', 'cloud', 'cloud',
			${opts.externalTenantId}, ${opts.status}, ${sql.json(opts.metadata)}
		)
	`;
}

async function insertBinding(
	sql: ReturnType<typeof getDb>,
	opts: {
		orgId: string;
		agentId: string;
		platform: string;
		channelId: string;
		teamId: string | null;
	},
): Promise<void> {
	await sql`
		INSERT INTO agent_channel_bindings (
			organization_id, agent_id, platform, channel_id, team_id, created_at
		) VALUES (
			${opts.orgId}, ${opts.agentId}, ${opts.platform}, ${opts.channelId},
			${opts.teamId}, NOW()
		)
	`;
}
