/**
 * Connector-definition refresh (#14). Drives refreshConnectorDefinitions()
 * against real Postgres + the real bundled github connector source.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { refreshConnectorDefinitions } from "../../scheduled/refresh-connector-definitions.js";
import {
	getAppInstallationAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-refresh";
const OTHER_ORG = "org-refresh-other";
const GITHUB_KEY = "github";

/** The pre-PR5 github auth_schema: oauth + env_keys only, no app_installation. */
const STALE_GITHUB_AUTH_SCHEMA = {
	methods: [
		{ type: "oauth", provider: "github", clientIdKey: "GITHUB_CLIENT_ID" },
		{ type: "env_keys", fields: [{ key: "GITHUB_TOKEN" }] },
	],
};

/** Insert an active, deliberately-stale github definition for an org. */
async function seedStaleGithubDef(
	orgId: string,
	opts: { loginEnabled?: boolean } = {},
): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version,
      auth_schema, status, login_enabled
    ) VALUES (
      ${orgId}, ${GITHUB_KEY}, 'GitHub', '0.0.1',
      ${sql.json(STALE_GITHUB_AUTH_SCHEMA)}, 'active', ${opts.loginEnabled ?? false}
    )
  `;
}

async function loadGithubDef(orgId: string): Promise<{
	auth_schema: unknown;
	version: string;
	login_enabled: boolean;
} | undefined> {
	const sql = getDb();
	const rows = (await sql`
    SELECT auth_schema, version, login_enabled
    FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${GITHUB_KEY} AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{
		auth_schema: unknown;
		version: string;
		login_enabled: boolean;
	}>;
	return rows[0];
}

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
}, 30_000);

describe("refreshConnectorDefinitions", () => {
	test("a stale github def gains the app_installation method after refresh", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleGithubDef(ORG, { loginEnabled: true });

		// Precondition: the seeded def has NO app_installation method.
		const before = await loadGithubDef(ORG);
		expect(before).toBeDefined();
		expect(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(before?.auth_schema),
			).length,
		).toBe(0);

		const result = await refreshConnectorDefinitions();
		expect(result.refreshed).toBeGreaterThanOrEqual(1);

		const after = await loadGithubDef(ORG);
		expect(after).toBeDefined();
		// The code-defined github schema carries an app_installation method now,
		// so the install callback's hasAppInstallMethod check passes.
		const appMethods = getAppInstallationAuthMethods(
			normalizeConnectorAuthSchema(after?.auth_schema),
		);
		expect(appMethods.length).toBeGreaterThanOrEqual(1);
		expect(appMethods[0].provider).toBe("github");
		// Version was bumped from the stale 0.0.1 to whatever the code declares.
		expect(after?.version).not.toBe("0.0.1");
		// Org-specific config (login_enabled) is preserved across the refresh.
		expect(after?.login_enabled).toBe(true);
	});

	test("refresh is idempotent — a second run changes nothing observable", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleGithubDef(ORG);

		await refreshConnectorDefinitions();
		const first = await loadGithubDef(ORG);

		await refreshConnectorDefinitions();
		const second = await loadGithubDef(ORG);

		expect(second?.version).toBe(first?.version);
		expect(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(second?.auth_schema),
			).length,
		).toBe(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(first?.auth_schema),
			).length,
		);
	});

	test("does not install a connector into an org that didn't have it", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedAgentRow("agent-other", { organizationId: OTHER_ORG });
		// Only ORG has github; OTHER_ORG has none.
		await seedStaleGithubDef(ORG);

		await refreshConnectorDefinitions();

		const other = await loadGithubDef(OTHER_ORG);
		expect(other).toBeUndefined();
	});
});
