/**
 * Regression: `manage_connections` create must accept a serverless connection
 * (no device worker). The UI/serverless callers send `device_worker_id: null`
 * explicitly; the create-path schema used a bare `Type.String`, so validation
 * rejected null with "Invalid arguments for manage_connections:
 * /device_worker_id: Expected string" before a connection was ever created.
 *
 * The fix makes the create (and connect) `device_worker_id` nullable —
 * `Type.Union([Type.String(), Type.Null()])` — matching the update action and
 * `resolveDeviceBinding`, which already normalizes null/empty to serverless.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const CONNECTOR_KEY = "demo.serverless";

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

beforeAll(async () => {
	await initWorkspaceProvider();
});

async function seedConnector(organizationId: string): Promise<void> {
	await createTestConnectorDefinition({
		key: CONNECTOR_KEY,
		name: "Demo Serverless",
		organization_id: organizationId,
		auth_schema: { methods: [{ type: "none" }] },
		feeds_schema: { items: {} },
	});
}

afterEach(async () => {
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
});

describe("manage_connections — serverless create (no device worker)", () => {
	it("create with device_worker_id: null succeeds and runs serverless", async () => {
		const org = await createTestOrganization({ name: "Serverless Null Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "serverless-null",
				display_name: "Serverless Null",
				device_worker_id: null,
			},
			TEST_ENV,
			ctx,
		);

		expect("error" in res).toBe(false);
		if (!("connection" in res)) throw new Error("expected a connection in result");
		const connection = res.connection as { id: number; device_worker_id: unknown };
		expect(connection.id).toBeGreaterThan(0);
		// Serverless: no device bound.
		expect(connection.device_worker_id ?? null).toBeNull();
	});

	it("create with device_worker_id omitted succeeds and runs serverless", async () => {
		const org = await createTestOrganization({ name: "Serverless Omit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "serverless-omit",
				display_name: "Serverless Omit",
			},
			TEST_ENV,
			ctx,
		);

		expect("error" in res).toBe(false);
		if (!("connection" in res)) throw new Error("expected a connection in result");
		const connection = res.connection as { id: number; device_worker_id: unknown };
		expect(connection.id).toBeGreaterThan(0);
		expect(connection.device_worker_id ?? null).toBeNull();
	});
});
