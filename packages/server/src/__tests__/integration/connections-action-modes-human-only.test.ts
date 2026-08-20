/**
 * `connection.config.action_modes` is a human-web-session-only control surface.
 * The map takes precedence over connector approval defaults, so autonomous and
 * token callers may round-trip unchanged modes but cannot change them.
 *
 * Every `manage_connections` path that can persist caller-supplied modes is covered:
 *   - update  (merge/replace of connection.config) — gated when modes change,
 *     so an agent round-tripping a read config keeps editing other keys
 *   - create  (mints the collector connection row)
 *   - connect / connect_managed (the recommended create path, same insert)
 *   - update_connector_default_config (defaults seed every future connection;
 *     a full-replace write, gated when modes change vs the STORED defaults so
 *     removal is caught too)
 *
 * Chat create/apply/update paths sanitize config through `parseConfig`, whose
 * `Value.Clean` strips `action_modes` before persistence.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ConnectionsArgs } from "../../tools/admin/manage_connections/schemas";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "os.shell";
const sql = getTestDb();

async function storedConfig(
	connectionId: number,
): Promise<Record<string, unknown>> {
	const [row] = (await sql`
    SELECT config FROM connections WHERE id = ${connectionId}
  `) as unknown as Array<{ config: Record<string, unknown> | null }>;
	return row?.config ?? {};
}

async function callManageConnections(
	args: ConnectionsArgs,
	ctx: ToolContext,
): Promise<Record<string, unknown>> {
	return (await manageConnections(args, {} as Env, ctx)) as Record<
		string,
		unknown
	>;
}

describe("connection action_modes writes are human-only", () => {
	let orgId: string;
	let userId: string;
	let humanCtx: ToolContext;
	let agentCtx: ToolContext;
	let mcpCtx: ToolContext;
	let tokenCtx: ToolContext;
	let systemCtx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx } = await seedOwnerContext({
			orgName: "Action Modes Gate Org",
		});
		orgId = org.id;
		userId = user.id;
		humanCtx = { ...ctx, tokenType: "session" };
		// An MCP-bound agent runs under its user's membership: same user, but the
		// session carries the agent identity. MCP transport likewise marks a
		// non-human decision path.
		agentCtx = { ...humanCtx, agentId: "automation-agent" };
		mcpCtx = { ...humanCtx, mcpSessionId: "mcp-session-1" };
		// A real API token always carries a client marker — the PAT verifier
		// stamps `pat_<id>` and OAuth tokens carry their client id — so the
		// clientId arm of the gate is what denies token callers.
		tokenCtx = { ...ctx, tokenType: "pat", clientId: "pat_1" };
		// An Automation REACTION carries no user, agent or client id at all — it
		// is an in-process system call (`userId: null`, `memberRole: null`,
		// `tokenType: 'session'`; see reaction-executor.ts) and so clears the
		// role gates on create / connect / connector defaults. Absence of a
		// machine marker is not humanity: the modes gate must still stop it.
		systemCtx = {
			...humanCtx,
			userId: null,
			memberRole: null,
			tokenType: "session",
		};
		await createTestConnectorDefinition({
			organization_id: orgId,
			key: CONNECTOR_KEY,
			name: "Shell",
		});
	});

	async function seedConnection(): Promise<number> {
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
		});
		return conn.id;
	}

	const deniedContexts: Array<[string, () => ToolContext]> = [
		["agent session", () => agentCtx],
		["MCP transport", () => mcpCtx],
		["API token (client-bearing) context", () => tokenCtx],
	];

	it.each(deniedContexts)("%s cannot flip an operation to auto", async (_, getCtx) => {
		const connectionId = await seedConnection();
		const result = await callManageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "auto" } },
			},
			getCtx(),
		);

		expect(String(result.error)).toMatch(/human web session/i);
		expect((await storedConfig(connectionId)).action_modes).toBeUndefined();
	});

	it("an automation reaction (no user identity) cannot either", async () => {
		// `update` is separately fenced by "you can only update connections you
		// created", so probe `create` — the path a userless system context
		// otherwise walks straight through.
		const result = await callManageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				display_name: "Reaction Created Shell",
				config: { action_modes: { run: "auto" } },
			},
			systemCtx,
		);

		expect(String(result.error)).toMatch(/human web session/i);
		const [planted] = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId} AND display_name = 'Reaction Created Shell'
    `) as unknown as Array<{ id: number }>;
		expect(planted).toBeUndefined();
	});

	it("a human session can change modes", async () => {
		const connectionId = await seedConnection();
		const result = await callManageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "auto" } },
			},
			humanCtx,
		);

		expect(result.error).toBeUndefined();
		expect(
			((await storedConfig(connectionId)).action_modes as Record<
				string,
				string
			>).run,
		).toBe("auto");
	});

	it("an agent round-tripping unchanged modes still edits other config keys", async () => {
		const connectionId = await seedConnection();
		const asHuman = await callManageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "approval" } },
			},
			humanCtx,
		);
		expect(asHuman.error).toBeUndefined();

		// The Owletto/SDK pattern: read config, spread it, patch one key back.
		const asAgent = await callManageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "approval" }, greeting: "hello" },
			},
			agentCtx,
		);

		expect(asAgent.error).toBeUndefined();
		const stored = await storedConfig(connectionId);
		expect(stored.greeting).toBe("hello");
		expect((stored.action_modes as Record<string, string>).run).toBe(
			"approval",
		);
	});

	it("an agent cannot remove modes through merge or replace", async () => {
		const patches: Array<{
			config: Record<string, unknown>;
			replace_config?: boolean;
		}> = [
			{ config: { action_modes: {} } },
			{ config: { greeting: "replacement" }, replace_config: true },
		];

		for (const patch of patches) {
			const connectionId = await seedConnection();
			await callManageConnections(
				{
					action: "update",
					connection_id: connectionId,
					config: { action_modes: { run: "approval" } },
				},
				humanCtx,
			);

			const result = await callManageConnections(
				{ action: "update", connection_id: connectionId, ...patch },
				agentCtx,
			);

			expect(String(result.error)).toMatch(/human web session/i);
			expect((await storedConfig(connectionId)).action_modes).toEqual({
				run: "approval",
			});
		}
	});

	it("an agent cannot plant modes at create", async () => {
		const result = await callManageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				display_name: "Agent Created Shell",
				config: { action_modes: { run: "auto" } },
			},
			agentCtx,
		);

		expect(String(result.error)).toMatch(/human web session/i);
	});

	it("an agent cannot seed modes through connector defaults", async () => {
		const result = await callManageConnections(
			{
				action: "update_connector_default_config",
				connector_key: CONNECTOR_KEY,
				default_connection_config: { action_modes: { run: "auto" } },
			},
			agentCtx,
		);

		expect(String(result.error)).toMatch(/human web session/i);
	});

	it("an agent cannot plant modes through connect", async () => {
		const result = await callManageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				display_name: "Agent Connected Shell",
				config: { action_modes: { run: "auto" } },
			},
			agentCtx,
		);

		expect(String(result.error)).toMatch(/human web session/i);
		const [planted] = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${orgId} AND display_name = 'Agent Connected Shell'
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
		expect(planted).toBeUndefined();
	});

	it("an agent cannot plant modes through managed connect before enrollment", async () => {
		const result = await callManageConnections(
			{
				action: "connect_managed",
				connector_key: CONNECTOR_KEY,
				managed_by_org: "unreachable-managed-org",
				config: { action_modes: { run: "auto" } },
			},
			agentCtx,
		);

		expect(String(result.error)).toMatch(/human web session/i);
	});

	// Defaults are replaced, so removal must be compared with the stored map.
	// Use a separate connector to keep these mutations independent.
	describe("connector defaults removal", () => {
		const DEFAULTS_KEY = "os.shell-defaults-gate";

		async function storedDefaults(): Promise<Record<string, unknown> | null> {
			const [row] = (await sql`
        SELECT default_connection_config FROM connector_definitions
        WHERE key = ${DEFAULTS_KEY} AND organization_id = ${orgId} AND status = 'active'
      `) as unknown as Array<{
				default_connection_config: Record<string, unknown> | null;
			}>;
			return row?.default_connection_config ?? null;
		}

		beforeAll(async () => {
			await createTestConnectorDefinition({
				organization_id: orgId,
				key: DEFAULTS_KEY,
				name: "Shell Defaults Gate",
			});
		});

		beforeEach(async () => {
			const seeded = await callManageConnections(
				{
					action: "update_connector_default_config",
					connector_key: DEFAULTS_KEY,
					default_connection_config: {
						action_modes: { run: "approval" },
						workdir: "/srv",
					},
				},
				humanCtx,
			);
			expect(seeded.success).toBe(true);
		});

		it("an agent cannot remove modes from connector defaults", async () => {
			const result = await callManageConnections(
				{
					action: "update_connector_default_config",
					connector_key: DEFAULTS_KEY,
					default_connection_config: { workdir: "/srv" },
				},
				agentCtx,
			);

			expect(String(result.error)).toMatch(/human web session/i);
			expect((await storedDefaults())?.action_modes).toEqual({
				run: "approval",
			});
		});

		it("an agent round-tripping unchanged modes still edits other default keys", async () => {
			const result = await callManageConnections(
				{
					action: "update_connector_default_config",
					connector_key: DEFAULTS_KEY,
					default_connection_config: {
						action_modes: { run: "approval" },
						workdir: "/srv/updated",
					},
				},
				agentCtx,
			);

			expect(result.success).toBe(true);
			const defaults = await storedDefaults();
			expect(defaults?.action_modes).toEqual({ run: "approval" });
			expect(defaults?.workdir).toBe("/srv/updated");
		});

		it("a human can remove modes from connector defaults", async () => {
			const result = await callManageConnections(
				{
					action: "update_connector_default_config",
					connector_key: DEFAULTS_KEY,
					default_connection_config: { workdir: "/srv/updated" },
				},
				humanCtx,
			);

			expect(result.success).toBe(true);
			expect((await storedDefaults())?.action_modes).toBeUndefined();
		});
	});
});
