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

/** Seed a connector whose PRIMARY auth method is app_installation (like github). */
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
				// A fallback method is present, but app_installation is PRIMARY.
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
