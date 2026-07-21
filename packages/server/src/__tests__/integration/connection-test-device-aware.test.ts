/**
 * connections.test must report device availability for auth-free, device-bound
 * connections.
 *
 * An auth-free, device-bound connection such as apple.computer_use has no auth
 * profile because it runs on a paired device. The test handler used to fall
 * through to "No auth profile configured" for these, hiding the real signal
 * (is the device online?). It now reports device availability: ok when the device
 * is online, a retryable warning when it is offline.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "apple.computer_use";

describe("connections.test device availability", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({
			orgName: "Device Test Org",
		});
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		// The real apple.computer_use connector declares the `none` auth method, so
		// an active connector_definition with `auth_schema.methods: [{ type: "none" }]`
		// must exist for this test to reproduce production: without it, the no-auth
		// branch never fires and the device branch is falsely reachable regardless
		// of ordering.
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Apple Computer Use",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "none" }] },
		});
	});

	async function seedDeviceConnection(online: boolean): Promise<number> {
		const sql = getTestDb();
		const lastSeen = online
			? new Date().toISOString()
			: new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago = offline
		const [dw] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
			) VALUES (
				${userId}, ${`wk_${online ? "on" : "off"}_${Date.now()}`}, 'macos',
				${sql.json([])}, ${online ? "My Mac (online)" : "My Mac (offline)"},
				${orgId}, ${lastSeen}
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
			createDefaultFeed: false,
		});
		// Attach the device; this auth-free connection carries no auth profile.
		await sql`UPDATE connections SET device_worker_id = ${dw.id} WHERE id = ${conn.id}`;
		return conn.id;
	}

	async function test(connectionId: number): Promise<Record<string, unknown>> {
		return (await manageConnections(
			{ action: "test", connection_id: connectionId },
			{} as Env,
			ctx,
		)) as Record<string, unknown>;
	}

	it("reports ok for an online device instead of 'No auth profile configured'", async () => {
		const id = await seedDeviceConnection(true);
		const result = await test(id);
		expect(result.status).toBe("ok");
		expect(result.device_online).toBe(true);
		expect(String(result.message)).not.toContain("No auth profile");
		expect(String(result.message)).toMatch(/online/i);
	});

	it("reports a retryable warning for an offline device", async () => {
		const id = await seedDeviceConnection(false);
		const result = await test(id);
		expect(result.status).toBe("warning");
		expect(result.device_online).toBe(false);
		expect(result.retryable).toBe(true);
		expect(String(result.message)).toMatch(/offline/i);
	});
});
