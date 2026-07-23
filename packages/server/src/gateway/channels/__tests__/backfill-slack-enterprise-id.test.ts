/**
 * The Grid enterprise id must live on a Slack connection's projection so a later
 * per-workspace reinstall can recognize and retire an orphaned org-wide (`E…`)
 * generation. This replays the migration body so its data cleanup cannot drift
 * from production SQL.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { getDb } from "../../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../__tests__/helpers/db-setup.js";

const ORG = "org-entbackfill";
const ENTERPRISE = "E_BACKFILL";

async function runMigrationUp(): Promise<void> {
	const sql = await readFile(
		new URL(
			"../../../../../../db/migrations/20260723200000_backfill_slack_enterprise_id_on_connections.sql",
			import.meta.url,
		),
		"utf8",
	);
	const start = sql.indexOf("-- migrate:up");
	const end = sql.indexOf("-- migrate:down");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	await getDb().unsafe(sql.slice(start + "-- migrate:up".length, end));
}

async function insertInstall(opts: {
	externalTenantId: string;
	externalId: string;
	enterpriseId: string | null;
	// Omit to reproduce the real per-workspace Grid shape: `buildMetadata` only
	// writes `is_enterprise_install` when truthy, so the key is absent (not
	// `false`) on the backing install — the null-vs-false gap the COALESCE guards.
	isEnterpriseInstall?: boolean;
}): Promise<void> {
	await getDb()`
    INSERT INTO app_installations (
      organization_id, provider, provider_app_id, external_tenant_id, status, metadata
    ) VALUES (
      ${ORG}, 'slack', 'A_TEST', ${opts.externalTenantId}, 'active',
			${getDb().json({
				external_id: opts.externalId,
				...(opts.enterpriseId ? { enterprise_id: opts.enterpriseId } : {}),
				...(opts.isEnterpriseInstall === undefined
					? {}
					: { is_enterprise_install: opts.isEnterpriseInstall }),
			})}
    )
  `;
}

async function insertConnection(opts: {
	slug: string;
	externalTenantId: string;
	live: boolean;
	config?: Record<string, unknown>;
}): Promise<number> {
	const rows = await getDb()`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      credential_mode, external_tenant_id, config, deleted_at
    ) VALUES (
      ${ORG}, 'slack', ${opts.slug}, 'Workspace', 'active',
      'managed', ${opts.externalTenantId},
      ${getDb().json(opts.config ?? {})}, ${opts.live ? null : new Date()}
    )
    RETURNING id
  `;
	return Number(rows[0].id);
}

async function connEnterpriseId(id: number): Promise<string | null> {
	const rows = await getDb()<{ ent: string | null }>`
    SELECT config->'chatMetadata'->>'enterpriseId' AS ent FROM connections WHERE id = ${id}
  `;
	return rows[0]?.ent ?? null;
}

async function connIsEnterpriseInstall(id: number): Promise<boolean | null> {
	const rows = await getDb()<{ org_wide: boolean | null }>`
    SELECT (config->'chatMetadata'->'isEnterpriseInstall')::boolean AS org_wide
    FROM connections WHERE id = ${id}
  `;
	return rows[0]?.org_wide ?? null;
}

async function connIsLive(id: number): Promise<boolean> {
	const rows = await getDb()`
    SELECT 1 FROM connections WHERE id = ${id} AND deleted_at IS NULL
  `;
	return rows.length > 0;
}

describe("backfill slack enterprise id migration", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		await getDb()`
      INSERT INTO organization (id, name, slug) VALUES (${ORG}, 'Ent Backfill', ${ORG})
      ON CONFLICT (id) DO NOTHING
    `;
	});

	afterAll(async () => {
		await resetTestDatabase();
	});

	test("backfills enterpriseId onto a connection from its install", async () => {
		await insertInstall({
			externalTenantId: "T_LIVE",
			externalId: "slackinst-live",
			enterpriseId: ENTERPRISE,
			isEnterpriseInstall: true,
		});
		const conn = await insertConnection({
			slug: "slackinst-live",
			externalTenantId: "T_LIVE",
			live: true,
		});

		// A connection whose config has NO chatMetadata object yet — the backfill must
		// still create it (jsonb_set alone cannot create the intermediate key).
		expect(await connEnterpriseId(conn)).toBeNull();
		await runMigrationUp();
		expect(await connEnterpriseId(conn)).toBe(ENTERPRISE);
	});

	test("backfills a missing org-wide flag when enterpriseId is already present", async () => {
		await insertInstall({
			externalTenantId: "E_ALREADY",
			externalId: "slackinst-existing-enterprise",
			enterpriseId: "E_ALREADY",
			isEnterpriseInstall: true,
		});
		const conn = await insertConnection({
			slug: "slackinst-existing-enterprise",
			externalTenantId: "E_ALREADY",
			live: true,
			config: { chatMetadata: { enterpriseId: "E_ALREADY" } },
		});

		expect(await connIsEnterpriseInstall(conn)).toBeNull();
		await runMigrationUp();
		expect(await connIsEnterpriseInstall(conn)).toBe(true);
	});

	test("backfills isEnterpriseInstall as false when the install omits the key", async () => {
		// Real per-workspace Grid shape: `enterprise_id` is set but the
		// `is_enterprise_install` key is absent on the backing install. The
		// COALESCE must land JSON boolean `false`, never JSON `null`.
		await insertInstall({
			externalTenantId: "T_NOKEY",
			externalId: "slackinst-nokey",
			enterpriseId: ENTERPRISE,
			// isEnterpriseInstall omitted on purpose.
		});
		const conn = await insertConnection({
			slug: "slackinst-nokey",
			externalTenantId: "T_NOKEY",
			live: true,
		});

		await runMigrationUp();

		expect(await connEnterpriseId(conn)).toBe(ENTERPRISE);
		// `false`, not `null`: a JSON null would fail this assertion, catching the gap.
		expect(await connIsEnterpriseInstall(conn)).toBe(false);
	});

	test("retires a live org-wide (E…) connection superseded by a per-workspace sibling", async () => {
		// Backing install for the live workspace connection carries the enterprise id.
		await insertInstall({
			externalTenantId: "T_WS",
			externalId: "slackinst-ws",
			enterpriseId: ENTERPRISE,
			isEnterpriseInstall: true,
		});
		// The live per-workspace (T…) connection — backfill will stamp its enterprise id.
		const workspace = await insertConnection({
			slug: "slackinst-ws",
			externalTenantId: "T_WS",
			live: true,
		});
		// The orphaned org-wide connection has no backing install and is superseded
		// by the active workspace projection above.
		const orphan = await insertConnection({
			slug: "slackinst-orgwide",
			externalTenantId: ENTERPRISE,
			live: true,
		});

		await runMigrationUp();

		expect(await connIsLive(workspace)).toBe(true);
		expect(await connEnterpriseId(workspace)).toBe(ENTERPRISE);
		expect(await connIsLive(orphan)).toBe(false);
	});

	test("never retires an org-wide connection with no live per-workspace sibling", async () => {
		// An org-wide (E…) connection whose workspace was never reinstalled
		// per-workspace: no live T… sibling carries this enterprise id, so it stays.
		const lone = await insertConnection({
			slug: "slackinst-lone-orgwide",
			externalTenantId: ENTERPRISE,
			live: true,
		});

		await runMigrationUp();

		expect(await connIsLive(lone)).toBe(true);
	});

	test("never retires an org-wide connection for a paused per-workspace sibling", async () => {
		await insertConnection({
			slug: "slackinst-paused-workspace",
			externalTenantId: "T_PAUSED",
			live: true,
			config: { chatMetadata: { enterpriseId: ENTERPRISE } },
		});
		await getDb()`
      UPDATE connections SET status = 'paused'
      WHERE slug = 'slackinst-paused-workspace'
    `;
		const orgWide = await insertConnection({
			slug: "slackinst-live-orgwide",
			externalTenantId: ENTERPRISE,
			live: true,
		});

		await runMigrationUp();

		expect(await connIsLive(orgWide)).toBe(true);
	});

	test("never retires an org-wide connection with an active backing install", async () => {
		await insertInstall({
			externalTenantId: ENTERPRISE,
			externalId: "slackinst-backed-orgwide",
			enterpriseId: ENTERPRISE,
			isEnterpriseInstall: true,
		});
		await insertConnection({
			slug: "slackinst-live-workspace",
			externalTenantId: "T_LIVE_SIBLING",
			live: true,
			config: { chatMetadata: { enterpriseId: ENTERPRISE } },
		});
		const orgWide = await insertConnection({
			slug: "slackinst-backed-orgwide",
			externalTenantId: ENTERPRISE,
			live: true,
		});

		await runMigrationUp();

		expect(await connIsLive(orgWide)).toBe(true);
	});

	test("never crosses orgs when superseding", async () => {
		const OTHER = "org-other-ent";
		await getDb()`
      INSERT INTO organization (id, name, slug) VALUES (${OTHER}, 'Other', ${OTHER})
      ON CONFLICT (id) DO NOTHING
    `;
		// Live per-workspace sibling in ORG carrying the enterprise id...
		await insertConnection({
			slug: "slackinst-ws-org",
			externalTenantId: "T_WS2",
			live: true,
			config: { chatMetadata: { enterpriseId: ENTERPRISE } },
		});
		// ...must NOT retire an org-wide connection of the same enterprise in ANOTHER org.
		const otherOrphan = (
			await getDb()`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          credential_mode, external_tenant_id, config, deleted_at
        ) VALUES (
          ${OTHER}, 'slack', 'slackinst-other-orgwide', 'Workspace', 'active',
          'managed', ${ENTERPRISE}, '{}', null
        )
        RETURNING id
      `
		)[0].id as number;

		await runMigrationUp();

		expect(await connIsLive(Number(otherOrphan))).toBe(true);
	});
});
