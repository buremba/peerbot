/**
 * Connections-unify FINAL migration — deploy-time re-sync + DROP agent_connections
 * (`20260630000000_connections_unify_resync_and_drop.sql`).
 *
 * This is the irreversible step, so its data transformation is the highest-risk
 * part of the cutover. The migration runs in a maintenance window with
 * agent_connections frozen; here we recreate that frozen table, seed the five
 * states the re-sync must reconcile, run the migration's `-- migrate:up` body
 * VERBATIM (the SQL prod applies), and assert `connections` converged:
 *   A. upsert-missing — a BYO row with no projection yet becomes a connection;
 *   B. config-drift — a stale projection is re-synced to the legacy config/status;
 *   C. orphan-prune — a BYO projection whose legacy row was deleted is soft-deleted;
 *   D. managed-demote — a managed install yields the active-tenant slot to a now-
 *      active BYO sibling (one-active-per-tenant);
 *   E. binding-relink — an unlinked binding gets connection_id set;
 *   F. the legacy table is dropped.
 *
 * The migration has GLOBAL-scope steps (orphan-prune + demote scan all orgs, and
 * it DROPs the table), so running it against the shared integration DB would
 * mutate other suites' data. We run the whole thing inside a transaction we ROLL
 * BACK — Postgres DDL is transactional, so the recreate, the re-sync, and the
 * DROP all vanish — capturing the assertions' inputs before the rollback.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { loadMigrationUpSection } from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

const MIGRATION = "20260630000000_connections_unify_resync_and_drop.sql";

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

/** Recreate the frozen legacy table shell (matches the baseline columns the
 *  migration reads). The suite already dropped it, so the test owns its lifetime
 *  inside the rolled-back transaction. */
const CREATE_LEGACY = `
	CREATE TABLE public.agent_connections (
		id text NOT NULL PRIMARY KEY,
		agent_id text NOT NULL,
		platform text NOT NULL,
		config jsonb DEFAULT '{}'::jsonb NOT NULL,
		settings jsonb DEFAULT '{}'::jsonb NOT NULL,
		metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
		status text DEFAULT 'active'::text NOT NULL,
		error_message text,
		created_at timestamp with time zone DEFAULT now() NOT NULL,
		updated_at timestamp with time zone DEFAULT now() NOT NULL,
		organization_id text NOT NULL
	)
`;

interface Captured {
	upsertMissing: { status: string; token: unknown } | null;
	drift: { status: string; token: unknown } | null;
	orphanDeleted: boolean | null;
	managed: { status: string } | null;
	byoTc: { status: string } | null;
	bindingLinked: boolean;
	webhook: { connectorKey: string; credentialMode: string | null } | null;
	tenantContention: { orphanPruned: boolean | null; newActive: string | null } | null;
	tableDropped: boolean;
}

class Rollback extends Error {}

describe("connections-unify resync + DROP migration", () => {
	let orgId: string;
	let agentId: string;
	let captured: Captured;

	beforeAll(async () => {
		await initWorkspaceProvider();
		orgId = (await createTestOrganization()).id;
		agentId = (await createTestAgent({ organizationId: orgId })).agentId;

		const sql = getDb();
		const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

		const result: Captured = {
			upsertMissing: null,
			drift: null,
			orphanDeleted: null,
			managed: null,
			byoTc: null,
			bindingLinked: false,
			webhook: null,
			tenantContention: null,
			tableDropped: false,
		};

		try {
			await sql.begin(async (tx: typeof sql) => {
				await tx.unsafe(CREATE_LEGACY);

				// ── seed the frozen legacy snapshot ──────────────────────────────
				// A: BYO telegram, no projection yet → must be upserted in.
				await tx`
					INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status)
					VALUES ('rs-tg-new', ${orgId}, ${agentId}, 'telegram',
					        ${tx.json({ platform: "telegram", botToken: "secret://tg-new" })},
					        ${tx.json({ allowGroups: true })}, ${tx.json({})}, 'active')
				`;
				// B: BYO slack with a STALE projection (old token, paused) → re-synced.
				await tx`
					INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status)
					VALUES ('rs-slack-drift', ${orgId}, ${agentId}, 'slack',
					        ${tx.json({ platform: "slack", botToken: "secret://NEW" })},
					        ${tx.json({})}, ${tx.json({ teamId: "TB" })}, 'active')
				`;
				await tx`
					INSERT INTO connections (organization_id, connector_key, external_tenant_id, agent_id, display_name, status, config, credential_mode, slug, visibility)
					VALUES (${orgId}, 'slack', 'TB', ${agentId}, 'slack', 'paused',
					        ${tx.json({ botToken: "secret://OLD", settings: {}, chatMetadata: { teamId: "TB" } })},
					        'byo', 'agentconn-rs-slack-drift', 'org')
				`;
				// C: orphan — a BYO projection with NO legacy row → soft-deleted.
				await tx`
					INSERT INTO connections (organization_id, connector_key, agent_id, display_name, status, config, credential_mode, slug, visibility)
					VALUES (${orgId}, 'telegram', ${agentId}, 'telegram', 'active',
					        ${tx.json({ settings: {}, chatMetadata: {} })}, 'byo', 'agentconn-rs-orphan', 'org')
				`;
				// D: a managed install active for team TC + a now-active BYO sibling
				//    for TC → the managed row must yield the slot (demoted to paused).
				await tx`
					INSERT INTO connections (organization_id, connector_key, external_tenant_id, display_name, status, config, credential_mode, slug, visibility)
					VALUES (${orgId}, 'slack', 'TC', 'slack', 'active',
					        ${tx.json({ chatMetadata: { teamId: "TC" } })}, 'managed', 'slackinst-rs-tc', 'org')
				`;
				await tx`
					INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status)
					VALUES ('rs-byo-tc', ${orgId}, ${agentId}, 'slack',
					        ${tx.json({ platform: "slack", botToken: "secret://byo-tc" })},
					        ${tx.json({})}, ${tx.json({ teamId: "TC" })}, 'active')
				`;
				// E: an unlinked binding for the telegram agent → connection_id set.
				await tx`
					INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id)
					VALUES (${orgId}, ${agentId}, 'telegram', 'telegram:chat-1', NULL)
				`;
				// G: a #1235 ingest-only `platform='webhook'` row — excluded by the
				//    Stage-1 chat allowlist, so it must be migrated here (not dropped).
				await tx`
					INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status)
					VALUES ('rs-webhook', ${orgId}, ${agentId}, 'webhook',
					        ${tx.json({ platform: "webhook", signatureSecret: "secret://wh" })},
					        ${tx.json({})}, ${tx.json({})}, 'active')
				`;
				// H: an ACTIVE orphan BYO projection for tenant TORPHAN (its legacy
				//    source is gone) PLUS a NEW active BYO row for the SAME tenant. The
				//    orphan must be pruned BEFORE the upsert, or inserting the new
				//    active row trips connections_active_chat_tenant (two active per
				//    tenant). No agent_connections row backs the orphan.
				await tx`
					INSERT INTO connections (organization_id, connector_key, external_tenant_id, agent_id, display_name, status, config, credential_mode, slug, visibility)
					VALUES (${orgId}, 'slack', 'TORPHAN', ${agentId}, 'slack', 'active',
					        ${tx.json({ settings: {}, chatMetadata: { teamId: "TORPHAN" } })}, 'byo', 'agentconn-rs-orphan-active', 'org')
				`;
				await tx`
					INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status)
					VALUES ('rs-new-torphan', ${orgId}, ${agentId}, 'slack',
					        ${tx.json({ platform: "slack", botToken: "secret://torphan" })},
					        ${tx.json({})}, ${tx.json({ teamId: "TORPHAN" })}, 'active')
				`;

				// ── run the migration's up-section verbatim ──────────────────────
				await tx.unsafe(upSection);

				// ── capture results (still inside the tx, pre-rollback) ──────────
				const [a] = await tx`
					SELECT status, config->>'botToken' AS token FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-tg-new' AND deleted_at IS NULL
				`;
				result.upsertMissing = a ? { status: a.status, token: a.token } : null;

				const [b] = await tx`
					SELECT status, config->>'botToken' AS token FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-slack-drift' AND deleted_at IS NULL
				`;
				result.drift = b ? { status: b.status, token: b.token } : null;

				const [c] = await tx`
					SELECT deleted_at FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-orphan'
				`;
				result.orphanDeleted = c ? c.deleted_at !== null : null;

				const [m] = await tx`
					SELECT status FROM connections
					WHERE organization_id = ${orgId} AND slug = 'slackinst-rs-tc'
				`;
				result.managed = m ? { status: m.status } : null;

				const [byo] = await tx`
					SELECT status FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-byo-tc' AND deleted_at IS NULL
				`;
				result.byoTc = byo ? { status: byo.status } : null;

				const [bind] = await tx`
					SELECT connection_id FROM agent_channel_bindings
					WHERE organization_id = ${orgId} AND channel_id = 'telegram:chat-1'
				`;
				result.bindingLinked = bind?.connection_id != null;

				const [wh] = await tx`
					SELECT connector_key, credential_mode FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-webhook' AND deleted_at IS NULL
				`;
				result.webhook = wh
					? { connectorKey: wh.connector_key, credentialMode: wh.credential_mode }
					: null;

				const [orphanActive] = await tx`
					SELECT deleted_at FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-orphan-active'
				`;
				const [newTorphan] = await tx`
					SELECT status FROM connections
					WHERE organization_id = ${orgId} AND slug = 'agentconn-rs-new-torphan' AND deleted_at IS NULL
				`;
				result.tenantContention = {
					orphanPruned: orphanActive ? orphanActive.deleted_at !== null : null,
					newActive: newTorphan?.status ?? null,
				};

				const [{ exists: tableExists }] = await tx`
					SELECT EXISTS (
						SELECT 1 FROM information_schema.tables
						WHERE table_schema = 'public' AND table_name = 'agent_connections'
					) AS exists
				`;
				result.tableDropped = tableExists === false;

				throw new Rollback();
			});
		} catch (error) {
			if (!(error instanceof Rollback)) throw error;
		}

		captured = result;
	}, 60_000);

	afterAll(async () => {
		await getDb()`DELETE FROM connections WHERE organization_id = ${orgId}`;
	});

	it("A. upserts a BYO connection that had no projection yet", () => {
		expect(captured.upsertMissing?.status).toBe("active");
		expect(captured.upsertMissing?.token).toBe("secret://tg-new");
	});

	it("B. re-syncs a stale projection to the frozen legacy config + status", () => {
		expect(captured.drift?.status).toBe("active"); // was paused
		expect(captured.drift?.token).toBe("secret://NEW"); // was secret://OLD
	});

	it("C. soft-deletes an orphan BYO projection whose legacy row is gone", () => {
		expect(captured.orphanDeleted).toBe(true);
	});

	it("D. demotes the managed install so the BYO sibling holds the tenant slot", () => {
		expect(captured.managed?.status).toBe("paused");
		expect(captured.byoTc?.status).toBe("active");
	});

	it("E. links a previously-unlinked binding to its connection", () => {
		expect(captured.bindingLinked).toBe(true);
	});

	it("G. migrates a platform=webhook (#1235) row instead of dropping it", () => {
		expect(captured.webhook?.connectorKey).toBe("webhook");
		expect(captured.webhook?.credentialMode).toBe("byo");
	});

	it("H. prunes an active orphan before upserting a new active row for the same tenant", () => {
		// The whole migration would throw on connections_active_chat_tenant if the
		// orphan were not pruned first; reaching here at all proves the ordering.
		expect(captured.tenantContention?.orphanPruned).toBe(true);
		expect(captured.tenantContention?.newActive).toBe("active");
	});

	it("F. drops the legacy agent_connections table", () => {
		expect(captured.tableDropped).toBe(true);
	});
});
