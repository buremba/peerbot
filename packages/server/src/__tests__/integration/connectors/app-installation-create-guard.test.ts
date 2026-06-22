/**
 * manage_connections create/connect guard: a connector whose PRIMARY auth method
 * is `app_installation` (e.g. github) must NOT be created directly with no
 * `installation_ref`. The only legitimate creator is the App install callback
 * (`linkGithubAppInstallation`), which stamps `config.installation_ref`. A direct
 * create with no ref would be a dead, unbound connection — so we reject it and
 * point the user at the install flow.
 *
 * The guard is connector-agnostic (keys on the auth method type), so this seeds a
 * generic `app_installation`-primary connector rather than github specifically.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { manageConnections } from "../../../tools/admin/manage_connections";
import { getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV = {} as Env;
const CONNECTOR_KEY = "demo.appinstall.guard";

function ctxFor(organizationId: string, userId: string): ToolContext {
	return {
		organizationId,
		userId,
		memberRole: "owner",
		agentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as ToolContext;
}

/**
 * Seed a connector whose PRIMARY auth method is app_installation, with oauth +
 * env_keys fallbacks — mirroring github's real schema (app_installation, oauth,
 * env_keys). The fallbacks let the selection-aware guard be exercised: a create
 * that targets oauth (auth_profile_slug) or env (config DEMO_TOKEN) must pass.
 */
async function seedAppInstallConnector(organizationId: string): Promise<void> {
	await createTestConnectorDefinition({
		key: CONNECTOR_KEY,
		name: "Demo App Install Guard",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "app_installation",
					provider: "github",
					providerInstance: "cloud",
					appIdKey: "DEMO_APP_ID",
					privateKeyKey: "DEMO_APP_PRIVATE_KEY",
				},
				{
					type: "oauth",
					provider: "github",
					requiredScopes: ["read:user"],
					clientIdKey: "DEMO_CLIENT_ID",
					clientSecretKey: "DEMO_CLIENT_SECRET",
					tokenUrl: "https://example.test/token",
				},
				{ type: "env_keys", fields: [{ key: "DEMO_TOKEN" }] },
			],
		},
		feeds_schema: { items: {} },
	});
}

async function connectionCount(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const rows = (await sql`
		SELECT count(*)::int AS n FROM connections
		WHERE organization_id = ${organizationId}
			AND connector_key = ${CONNECTOR_KEY}
			AND deleted_at IS NULL
	`) as unknown as Array<{ n: number }>;
	return rows[0].n;
}

beforeAll(async () => {
	await initWorkspaceProvider();
});

afterEach(async () => {
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
});

describe("manage_connections — app_installation create guard", () => {
	it("create with NO installation_ref is rejected with install-flow guidance, no row written", async () => {
		const org = await createTestOrganization({ name: "App Install Guard Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "should-not-exist",
				display_name: "Should Not Exist",
				device_worker_id: null,
			},
			TEST_ENV,
			ctx,
		);

		expect("error" in res).toBe(true);
		const err = (res as { error: string }).error;
		expect(err).toMatch(/install/i);
		expect(err).toMatch(/\/github\/app\/install/);
		// Zero rows created.
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("connect with NO installation_ref is also rejected (same guard, connect path)", async () => {
		const org = await createTestOrganization({ name: "App Install Connect Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				slug: "should-not-exist-connect",
			},
			TEST_ENV,
			ctx,
		);

		expect("error" in res).toBe(true);
		expect((res as { error: string }).error).toMatch(/\/github\/app\/install/);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("create WITH installation_ref in config is allowed past the guard (the callback's shape)", async () => {
		// The install callback creates the connection with config.installation_ref
		// set. The guard must NOT block that shape — it should pass through (any
		// later failure is unrelated to this guard).
		const org = await createTestOrganization({ name: "App Install Bound Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bound-conn",
				display_name: "Bound Conn",
				device_worker_id: null,
				config: { installation_ref: 12345 },
			},
			TEST_ENV,
			ctx,
		);

		// The guard did not reject it: either it created the row, or it failed for
		// some OTHER reason — but NOT with the install-flow guidance.
		if ("error" in res) {
			expect((res as { error: string }).error).not.toMatch(
				/\/github\/app\/install/,
			);
		} else {
			expect(await connectionCount(org.id)).toBe(1);
		}
	});
});

describe("manage_connections — app_installation guard is SELECTION-AWARE (regression)", () => {
	/** Assert the create/connect was NOT rejected by the app-install guard. */
	function expectGuardSkipped(res: unknown): void {
		if (res && typeof res === "object" && "error" in res) {
			// A later failure (e.g. missing OAuth profile) is fine — it must just NOT
			// be the install-flow guidance the guard produces.
			expect((res as { error: string }).error).not.toMatch(
				/\/github\/app\/install/,
			);
		}
		// No error at all is also a pass (guard skipped, create proceeded).
	}

	it("create WITH auth_profile_slug (oauth intent) is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "OAuth Profile Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "oauth-create",
				display_name: "OAuth Create",
				device_worker_id: null,
				auth_profile_slug: "some-oauth-profile",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("connect WITH auth_profile_slug (oauth intent) is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "OAuth Profile Connect Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				slug: "oauth-connect",
				auth_profile_slug: "some-oauth-profile",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("create WITH env/PAT creds in config is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "PAT Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "pat-create",
				display_name: "PAT Create",
				device_worker_id: null,
				// The connector's declared env field key — supplying it is env/PAT intent.
				config: { DEMO_TOKEN: "ghp_xxx_personal_access_token" },
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("create WITH app_auth_profile_slug is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "App Profile Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "appprofile-create",
				display_name: "App Profile Create",
				device_worker_id: null,
				app_auth_profile_slug: "some-oauth-app",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("lobu-apply-style oauth create (auth_profile_slug, no installation_ref) is ALLOWED", async () => {
		// `lobu apply` of a declared github oauth connection sends auth_profile_slug
		// (createConnection in apply/client.ts). It must pass the guard (it did on
		// origin/main — the over-broad guard broke it).
		const org = await createTestOrganization({ name: "Apply OAuth Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "apply-oauth-conn",
				display_name: "Apply OAuth Conn",
				device_worker_id: null,
				auth_profile_slug: "gh-oauth",
				app_auth_profile_slug: "gh-oauth-app",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("STILL rejects: create with NO creds and NO installation_ref → install-flow guidance", async () => {
		// The core intent must remain: a bare create (no auth intent) falls through
		// to the app_installation primary and is rejected.
		const org = await createTestOrganization({ name: "Bare Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bare-create",
				display_name: "Bare Create",
				device_worker_id: null,
			},
			TEST_ENV,
			ctx,
		);
		expect("error" in res).toBe(true);
		expect((res as { error: string }).error).toMatch(/\/github\/app\/install/);
		expect(await connectionCount(org.id)).toBe(0);
	});
});
