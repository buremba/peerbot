/**
 * Operation readiness must respect per-operation OAuth scopes.
 *
 * A connection can be active + authenticated (so status readiness is "ready")
 * yet still lack the OAuth scope a specific write action needs. Before this
 * change, `operations.listAvailable` reported such write actions as
 * `executable: true` — e.g. a Calendar connection granted only
 * `calendar.readonly` reported `create_event` ready, then the provider rejected
 * the write at execution time. Readiness now maps an action whose declared
 * `requiredScopes` are not covered by the connection's granted scopes to
 * `readiness: "scope_upgrade_required"` (not executable) with a `reauthorize`
 * next_action carrying exactly the missing scopes, while read actions on the
 * same connection stay executable.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "demo.scope.calendar";
const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Two write actions declaring the write scope, one read action declaring none —
// mirrors google.calendar (create/update/delete_event vs get_event).
const ACTIONS_SCHEMA = {
	create_event: {
		key: "create_event",
		name: "Create Event",
		kind: "write",
		requiresApproval: true,
		requiredScopes: [WRITE_SCOPE],
	},
	get_event: {
		key: "get_event",
		name: "Get Event",
		kind: "read",
	},
};

describe("operation readiness respects OAuth scopes", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	// connection granted only the readonly scope
	let readonlyConnId: number;
	// connection granted both readonly + write scopes
	let writableConnId: number;

	async function seedScopedConnection(
		grantedScopes: string[],
	): Promise<number> {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_event: "auto", get_event: "auto" } },
		});
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: CONNECTOR_KEY,
			displayName: `${CONNECTOR_KEY} OAuth ${conn.id}`,
			profileKind: "oauth_account",
			provider: "test",
			status: "active",
			createdBy: userId,
			authData: { granted_scopes: grantedScopes },
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}`;
		return conn.id;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({
			orgName: "Scope Readiness Org",
		});
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		const sql = getTestDb();
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Scope Calendar",
			organization_id: orgId,
			auth_schema: {
				methods: [
					{
						type: "oauth",
						provider: "test",
						requiredScopes: [READONLY_SCOPE],
						optionalScopes: [WRITE_SCOPE],
					},
				],
			},
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json(ACTIONS_SCHEMA)},
			    supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`class R { async sync(){return {items:[]};} async execute(ctx){return {success:true,output:{}};} } export { R };`}
			WHERE connector_key = ${CONNECTOR_KEY}
		`;

		readonlyConnId = await seedScopedConnection([READONLY_SCOPE]);
		writableConnId = await seedScopedConnection([READONLY_SCOPE, WRITE_SCOPE]);
	});

	async function listOp(
		operationKey: string,
		connectionId: number,
	): Promise<{
		readiness: string;
		executable: boolean;
		next_action?: Record<string, unknown>;
		execution_targets: Array<{
			connection_id: number;
			status: string;
			executable: boolean;
			reason: string;
		}>;
	}> {
		const listed = (await manageOperations(
			{ action: "list_available", connection_id: connectionId },
			{} as Env,
			ctx,
		)) as {
			operations: Array<{
				operation_key: string;
				readiness: string;
				executable: boolean;
				next_action?: Record<string, unknown>;
				execution_targets: Array<{
					connection_id: number;
					status: string;
					executable: boolean;
					reason: string;
				}>;
			}>;
		};
		const op = listed.operations.find((o) => o.operation_key === operationKey);
		if (!op)
			throw new Error(`${operationKey} not listed for conn ${connectionId}`);
		return op;
	}

	it("marks a write action not-executable when its required scope is missing", async () => {
		const op = await listOp("create_event", readonlyConnId);
		expect(op.executable).toBe(false);
		expect(op.readiness).toBe("scope_upgrade_required");
		const target = op.execution_targets.find(
			(t) => t.connection_id === readonlyConnId,
		);
		expect(target?.executable).toBe(false);
		expect(target?.status).toBe("scope_upgrade_required");
		expect(target?.reason).toContain(WRITE_SCOPE);
	});

	it("surfaces a reauthorize next_action naming exactly the missing scope", async () => {
		const op = await listOp("create_event", readonlyConnId);
		expect(op.next_action?.action).toBe("reauthorize");
		expect(op.next_action?.connection_id).toBe(readonlyConnId);
		expect(op.next_action?.requested_scopes).toEqual([WRITE_SCOPE]);
	});

	it("keeps read actions on the same connection executable", async () => {
		const op = await listOp("get_event", readonlyConnId);
		expect(op.executable).toBe(true);
		expect(op.readiness).toBe("ready");
	});

	it("marks the write action executable when the write scope IS granted", async () => {
		const op = await listOp("create_event", writableConnId);
		expect(op.executable).toBe(true);
		expect(op.readiness).toBe("ready");
	});
});
