/**
 * GitHub App install callback (app-installation design §4.4, PR5).
 *
 * `linkGithubAppInstallation` is the callback's pure core: given an org + a
 * GitHub `installation_id`, it must
 *   1. upsert an active `app_installations` row for the tenant tuple, and
 *   2. create (or relink) the org's `github` connector connection with
 *      `config.installation_ref` = the install id — the shape
 *      resolveExecutionAuth reads to mint a tenant-scoped token.
 *
 * It must be idempotent: a re-install / callback retry reuses the existing
 * install + connection instead of duplicating either.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { linkGithubAppInstallation } from "../../../gateway/routes/public/app-install";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestConnectorDefinition,
	createTestOrganization,
} from "../../setup/test-fixtures";

const CONNECTOR_KEY = "github";
const PROVIDER_APP_ID = "test-github-app";

async function seedGithubConnector(organizationId: string): Promise<void> {
	await createTestConnectorDefinition({
		key: CONNECTOR_KEY,
		name: "GitHub",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "app_installation",
					provider: "github",
					providerInstance: "cloud",
					appIdKey: "GITHUB_APP_ID",
					privateKeyKey: "GITHUB_APP_PRIVATE_KEY",
					appSlugKey: "GITHUB_APP_SLUG",
					clientIdKey: "GITHUB_APP_CLIENT_ID",
					clientSecretKey: "GITHUB_APP_CLIENT_SECRET",
					webhookSecretKey: "GITHUB_APP_WEBHOOK_SECRET",
					installUrlTemplate:
						"https://github.com/apps/{{app_slug}}/installations/new",
				},
			],
		},
		feeds_schema: { issues: {} },
	});
}

beforeAll(async () => {
	await initWorkspaceProvider();
});

beforeEach(async () => {
	// Keep the shared DB clean across runs of this suite.
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
});

afterEach(async () => {
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
});

describe("GitHub App install callback — link installation", () => {
	it("install: writes an active app_installations row + a connection bound to it", async () => {
		const org = await createTestOrganization({ name: "Installer Org" });
		await seedGithubConnector(org.id);
		const store = createPostgresAppInstallationStore();

		const result = await linkGithubAppInstallation({
			organizationId: org.id,
			installationId: "9001",
			store,
			providerAppId: PROVIDER_APP_ID,
			metadata: { account_login: "acme-co" },
		});

		expect(result.createdConnection).toBe(true);
		expect(result.installId).toBeGreaterThan(0);
		expect(result.connectionId).toBeGreaterThan(0);
		expect(result.accountLogin).toBe("acme-co");

		// app_installations row: active, github/cloud, external_tenant_id = installation_id.
		const install = await store.getById(result.installId);
		expect(install).not.toBeNull();
		expect(install?.organizationId).toBe(org.id);
		expect(install?.provider).toBe("github");
		expect(install?.providerInstance).toBe("cloud");
		expect(install?.providerAppId).toBe(PROVIDER_APP_ID);
		expect(install?.externalTenantId).toBe("9001");
		expect(install?.status).toBe("active");
		expect(install?.metadata?.account_login).toBe("acme-co");

		// Resolvable as the active install for its tenant tuple (the webhook router's lookup).
		const active = await store.resolveActiveByTenant({
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "9001",
		});
		expect(active?.id).toBe(result.installId);

		// connection: github connector, active, config.installation_ref = install id.
		const sql = getDb();
		const rows = (await sql`
			SELECT connector_key, status, config
			FROM connections
			WHERE id = ${result.connectionId} AND organization_id = ${org.id}
			LIMIT 1
		`) as unknown as Array<{
			connector_key: string;
			status: string;
			config: Record<string, unknown> | null;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].connector_key).toBe("github");
		expect(rows[0].status).toBe("active");
		expect(Number(rows[0].config?.installation_ref)).toBe(result.installId);
	});

	it("idempotent: a re-install for the same org+installation reuses the install + connection", async () => {
		const org = await createTestOrganization({ name: "Reinstall Org" });
		await seedGithubConnector(org.id);
		const store = createPostgresAppInstallationStore();

		const first = await linkGithubAppInstallation({
			organizationId: org.id,
			installationId: "9100",
			store,
			providerAppId: PROVIDER_APP_ID,
			metadata: { account_login: "reinstaller" },
		});
		const second = await linkGithubAppInstallation({
			organizationId: org.id,
			installationId: "9100",
			store,
			providerAppId: PROVIDER_APP_ID,
			metadata: { account_login: "reinstaller" },
		});

		// Same install row (same-org reinstall refreshes in place), no duplicate connection.
		expect(second.installId).toBe(first.installId);
		expect(second.connectionId).toBe(first.connectionId);
		expect(second.createdConnection).toBe(false);

		const sql = getDb();
		const connCount = (await sql`
			SELECT count(*)::int AS n FROM connections
			WHERE organization_id = ${org.id} AND connector_key = 'github' AND deleted_at IS NULL
		`) as unknown as Array<{ n: number }>;
		expect(connCount[0].n).toBe(1);

		const installCount = (await sql`
			SELECT count(*)::int AS n FROM app_installations
			WHERE provider_app_id = ${PROVIDER_APP_ID} AND external_tenant_id = '9100'
		`) as unknown as Array<{ n: number }>;
		expect(installCount[0].n).toBe(1);
	});
});
