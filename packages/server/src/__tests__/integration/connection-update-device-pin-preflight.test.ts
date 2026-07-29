/**
 * connections.update must refuse to re-pin onto a device another live
 * connection already holds — with a readable error, not a raw 23505.
 *
 * `idx_connections_org_connector_device_live` is UNIQUE on
 * (organization_id, connector_key, device_worker_id) for live rows. The CREATE
 * path already pre-flights this (see the duplicate check in crud.ts, whose
 * comment says it exists so callers get a clean error "instead of hitting the
 * partial unique index as a primary exception"). The UPDATE path did not, so
 * re-assigning a connection to an occupied device surfaced the driver's
 * constraint violation to the caller.
 *
 * Sibling of the background-poll instance fixed in #2286; that one degrades to
 * NULL because a poll has no user to talk to. This is user-initiated, so the
 * correct behaviour is a clean error — silently unpinning someone else's
 * connection would be wrong here.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import { isConnectionDevicePinUniqueViolation } from "../../utils/connections";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "apple.computer_use";
const sql = getTestDb();

describe("connections.update device pin pre-flight", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Pin Preflight Org",
		});
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;
		await createTestConnectorDefinition({
			organization_id: orgId,
			key: CONNECTOR_KEY,
			name: "Computer Use",
		});
	});

	async function seedDevice(label: string): Promise<string> {
		const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
		const [row] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label,
        organization_id, last_seen_at
      ) VALUES (
        ${userId}, ${workerId}, 'macos', ${sql.json(["computer_use"])},
        ${label}, ${orgId}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
		return String(row.id);
	}

	async function seedConnectionOnDevice(deviceId: string | null): Promise<number> {
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
		});
		if (deviceId) {
			await sql`
        UPDATE connections SET device_worker_id = ${deviceId}::uuid WHERE id = ${conn.id}
      `;
		}
		return conn.id;
	}

	async function update(
		connectionId: number,
		deviceWorkerId: string | null,
	): Promise<Record<string, unknown>> {
		return (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				device_worker_id: deviceWorkerId,
			},
			{} as Env,
			ctx,
		)) as Record<string, unknown>;
	}

	async function pinOf(id: number): Promise<string | null> {
		const [row] = (await sql`
      SELECT device_worker_id FROM connections WHERE id = ${id}
    `) as unknown as Array<{ device_worker_id: string | null }>;
		return row?.device_worker_id ?? null;
	}

	it("returns a readable error instead of a raw constraint violation", async () => {
		const macMini = await seedDevice("Mac mini");
		const macBook = await seedDevice("MacBook Pro");
		const occupant = await seedConnectionOnDevice(macMini);
		const mover = await seedConnectionOnDevice(macBook);

		const result = await update(mover, macMini);

		// The message must name the occupying connection, and must NOT be the
		// driver's constraint text leaking through.
		expect(String(result.error)).toContain(String(occupant));
		expect(String(result.error)).toMatch(/already assigned to that device/i);
		expect(String(result.error)).not.toMatch(/duplicate key|violates unique/i);

		// Neither row is mutated by a rejected update.
		expect(await pinOf(occupant)).toBe(macMini);
		expect(await pinOf(mover)).toBe(macBook);
	});

	it("rolls a lost race back entirely, error only, nothing persisted", async () => {
		// Both updates pass the pre-flight (the device is free when each reads),
		// then collide in the index. Deterministic because the winner's
		// transaction is held open until the loser has already passed its
		// pre-flight — no scan-order or timing luck involved.
		const contested = await seedDevice("Contested");
		const loser = await seedConnectionOnDevice(null);
		const [before] = (await sql`
      SELECT display_name FROM connections WHERE id = ${loser}
    `) as unknown as Array<{ display_name: string }>;

		// Winner: claims the device inside a transaction and holds it briefly, so
		// the loser's pre-flight reads BEFORE the claim is visible. The hold is a
		// fixed delay rather than a handshake — the loser must not gate the
		// winner's commit, or the two deadlock on the index.
		const winnerConn = await seedConnectionOnDevice(null);
		const winner = sql.begin(async (tx) => {
			await tx`
        UPDATE connections SET device_worker_id = ${contested}::uuid
        WHERE id = ${winnerConn}
      `;
			await new Promise((r) => setTimeout(r, 250));
		});

		// Loser: pre-flight sees the device free (winner uncommitted), proceeds to
		// the write, blocks on the index until the winner commits, then loses.
		await new Promise((r) => setTimeout(r, 50));
		const [result] = await Promise.all([update(loser, contested), winner]);

		expect(String(result.error)).toMatch(/already assigned to that device/i);
		expect(String(result.error)).not.toMatch(/duplicate key|violates unique/i);

		// Nothing of the loser's update survives.
		const [after] = (await sql`
      SELECT display_name, device_worker_id FROM connections WHERE id = ${loser}
    `) as unknown as Array<{ display_name: string; device_worker_id: string | null }>;
		expect(after.display_name).toBe(before.display_name);
		expect(after.device_worker_id).toBeNull();
	});

	it("still allows re-pinning to a free device", async () => {
		const inUse = await seedDevice("In Use");
		const free = await seedDevice("Free");
		await seedConnectionOnDevice(inUse);
		const mover = await seedConnectionOnDevice(null);

		const result = await update(mover, free);

		expect(result.error).toBeUndefined();
		expect(await pinOf(mover)).toBe(free);
	});

	it("still allows clearing a pin", async () => {
		const device = await seedDevice("Clearable");
		const conn = await seedConnectionOnDevice(device);

		const result = await update(conn, null);

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBeNull();
	});

	it("allows re-pinning a connection to the device it already holds", async () => {
		// The guard excludes the row being updated, so a no-op re-pin must not
		// report the connection as colliding with itself.
		const device = await seedDevice("Self");
		const conn = await seedConnectionOnDevice(device);

		const result = await update(conn, device);

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBe(device);
	});
});
