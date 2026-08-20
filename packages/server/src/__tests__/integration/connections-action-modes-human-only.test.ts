/**
 * `connection.config.action_modes` is a human-only control surface.
 *
 * The modes map is what unattended runs execute UNDER: `resolveActionMode`
 * consults it BEFORE the connector's `requiresApproval` default, so a
 * principal that can write it can grant itself `auto` on e.g. `os.shell` and
 * erase the approval gate for its own actions. `manage_connections`
 * create/update are member-tier, and an agent's MCP session carries its user's
 * membership, so membership alone cannot carry the decision — the identity
 * must be a verified human, the same rule operation-run approvals already
 * enforce.
 *
 * Every caller-supplied config write is gated:
 *   - update  (merge/replace of connection.config) — gated when modes CHANGE,
 *     so an agent round-tripping a read config keeps editing other keys
 *   - create  (config lands verbatim on the new row)
 *   - connect / connect_managed (the recommended create path, same insert)
 *   - update_connector_default_config (defaults seed every future connection)
 *
 * `apply_chat_connection` is not gated: its config goes through `parseConfig`,
 * whose `Value.Clean` strips keys outside the chat platform schema, so
 * `action_modes` can never reach the row that way.
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

describe("connection action_modes writes are human-only", () => {
	let orgId: string;
	let userId: string;
	let humanCtx: ToolContext;
	let agentCtx: ToolContext;
	let mcpCtx: ToolContext;
	let systemCtx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx } = await seedOwnerContext({
			orgName: "Action Modes Gate Org",
		});
		orgId = org.id;
		userId = user.id;
		humanCtx = ctx;
		// An MCP-bound agent runs under its user's membership: same user, but the
		// session carries the agent identity. MCP transport likewise marks a
		// non-human decision path.
		agentCtx = { ...ctx, agentId: "automation-agent" };
		mcpCtx = { ...ctx, mcpSessionId: "mcp-session-1" };
		// An Automation REACTION carries no user, agent or client id at all — it
		// is an in-process system call (`userId: null`, `memberRole: null`,
		// `tokenType: 'session'`; see reaction-executor.ts) and so clears the
		// role gates on create / connect / connector defaults. Absence of a
		// machine marker is not humanity: the modes gate must still stop it.
		systemCtx = {
			...ctx,
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

	it("an agent session cannot flip an operation to auto", async () => {
		const connectionId = await seedConnection();
		const result = (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			agentCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
		expect((await storedConfig(connectionId)).action_modes).toBeUndefined();
	});

	it("an MCP-transport session cannot either", async () => {
		const connectionId = await seedConnection();
		const result = (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			mcpCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
		expect((await storedConfig(connectionId)).action_modes).toBeUndefined();
	});

	it("an automation reaction (no user identity) cannot either", async () => {
		// `update` is separately fenced by "you can only update connections you
		// created", so probe `create` — the path a userless system context
		// otherwise walks straight through.
		const result = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				display_name: "Reaction Created Shell",
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			systemCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
		const [planted] = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId} AND display_name = 'Reaction Created Shell'
    `) as unknown as Array<{ id: number }>;
		expect(planted).toBeUndefined();
	});

	it("a human session can change modes", async () => {
		const connectionId = await seedConnection();
		const result = (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			humanCtx,
		)) as Record<string, unknown>;

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
		const asHuman = (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "approval" } },
			},
			{} as Env,
			humanCtx,
		)) as Record<string, unknown>;
		expect(asHuman.error).toBeUndefined();

		// The Owletto/SDK pattern: read config, spread it, patch one key back.
		const asAgent = (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { action_modes: { run: "approval" }, greeting: "hello" },
			},
			{} as Env,
			agentCtx,
		)) as Record<string, unknown>;

		expect(asAgent.error).toBeUndefined();
		const stored = await storedConfig(connectionId);
		expect(stored.greeting).toBe("hello");
		expect((stored.action_modes as Record<string, string>).run).toBe(
			"approval",
		);
	});

	it("an agent cannot plant modes at create", async () => {
		const result = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				display_name: "Agent Created Shell",
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			agentCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
	});

	it("an agent cannot seed modes through connector defaults", async () => {
		const result = (await manageConnections(
			{
				action: "update_connector_default_config",
				connector_key: CONNECTOR_KEY,
				default_connection_config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			agentCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
	});

	it("an agent cannot plant modes through connect", async () => {
		const result = (await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				display_name: "Agent Connected Shell",
				config: { action_modes: { run: "auto" } },
			},
			{} as Env,
			agentCtx,
		)) as Record<string, unknown>;

		expect(String(result.error)).toMatch(/human web session/i);
		const [planted] = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${orgId} AND display_name = 'Agent Connected Shell'
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
		expect(planted).toBeUndefined();
	});
});
