import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const LOCAL = "demo.ops.backend.local";
const MCP = "demo.ops.backend.mcp";
const HTTP = "demo.ops.backend.http";

function context(organizationId: string, userId: string): ToolContext {
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
		baseUrl: "https://gateway.test/lobu",
	} as ToolContext;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("operations.execute backend lifecycle", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let localConnectionId: number;
	let mcpConnectionId: number;
	let secondMcpConnectionId: number;
	let httpConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Operation Backends Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		orgId = org.id;
		userId = user.id;
		ctx = context(orgId, userId);

		for (const [key, name] of [
			[LOCAL, "Local backend"],
			[MCP, "MCP backend"],
			[HTTP, "HTTP backend"],
		] as const) {
			await createTestConnectorDefinition({
				key,
				name,
				organization_id: orgId,
				auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
			});
		}

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				echo: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
				needs_approval: {
					name: "Needs approval",
					kind: "write",
					requiresApproval: true,
				},
			})}
			WHERE organization_id = ${orgId} AND key = ${LOCAL}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) {
						return { success: true, output: { backend: 'local_action', value: ctx.input.value ?? null } };
					}
				}
				export { ConnectorRuntime };
			`}
			WHERE connector_key = ${LOCAL}
		`;
		await sql`
			UPDATE connector_definitions
			SET mcp_config = ${sql.json({ upstream_url: "https://mcp.example.test/mcp" })}
			WHERE organization_id = ${orgId} AND key = ${MCP}
		`;
		await sql`
			UPDATE connector_definitions
			SET openapi_config = ${sql.json({
				specUrl: "https://api.example.test/openapi.json",
				serverUrl: "https://api.example.test",
			})}
			WHERE organization_id = ${orgId} AND key = ${HTTP}
		`;

		const local = await createTestConnection({
			organization_id: orgId,
			connector_key: LOCAL,
			created_by: userId,
			visibility: "private",
		});
		const mcp = await createTestConnection({
			organization_id: orgId,
			connector_key: MCP,
			created_by: userId,
			visibility: "private",
		});
		const secondMcp = await createTestConnection({
			organization_id: orgId,
			connector_key: MCP,
			created_by: userId,
			visibility: "private",
		});
		const http = await createTestConnection({
			organization_id: orgId,
			connector_key: HTTP,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "auto" } },
		});
		localConnectionId = local.id;
		mcpConnectionId = mcp.id;
		secondMcpConnectionId = secondMcp.id;
		httpConnectionId = http.id;
		for (const [connectorKey, connectionId] of [
			[LOCAL, local.id],
			[MCP, mcp.id],
			[MCP, secondMcp.id],
			[HTTP, http.id],
		] as const) {
			const accountId = `acct_${connectionId}_${connectorKey}`;
			await sql`
				INSERT INTO "account" (
				  id, "accountId", "providerId", "userId",
				  "accessToken", "accessTokenExpiresAt", scope,
				  "createdAt", "updatedAt"
				) VALUES (
				  ${accountId}, ${accountId}, 'test', ${userId},
				  ${`backend-test-token-${connectionId}`}, ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}, 'read write',
				  NOW(), NOW()
				)
			`;
			const profile = await createAuthProfile({
				organizationId: orgId,
				connectorKey,
				displayName: `${connectorKey} test OAuth`,
				profileKind: "oauth_account",
				provider: "test",
				accountId,
				status: "active",
				createdBy: userId,
			});
			await sql`
				UPDATE connections
				SET auth_profile_id = ${profile.id}
				WHERE id = ${connectionId}
			`;
		}

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://api.example.test/openapi.json") {
					return jsonResponse({
						openapi: "3.0.0",
						servers: [{ url: "https://api.example.test" }],
						paths: {
							"/items": {
								post: {
									operationId: "create_item",
									requestBody: {
										content: {
											"application/json": {
												schema: { type: "object" },
											},
										},
									},
									responses: { "200": { description: "ok" } },
								},
							},
						},
					});
				}
				if (url === "https://api.example.test/items") {
					return jsonResponse({ created: true, body: JSON.parse(String(init?.body)) });
				}
				if (url === "https://mcp.example.test/mcp") {
					const request = JSON.parse(String(init?.body)) as {
						id?: number;
						method: string;
						params?: Record<string, unknown>;
					};
					if (request.method === "tools/list") {
						return jsonResponse({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								tools: [
									{
										name: "remote_echo",
										description: "Echo through MCP",
										inputSchema: { type: "object" },
										annotations: { readOnlyHint: true },
									},
								],
							},
						});
					}
					if (request.method === "tools/call") {
						if (
							(request.params?.arguments as Record<string, unknown> | undefined)
								?.fail_transport === true
						) {
							throw new Error("upstream transport failed");
						}
						const authorization = new Headers(init?.headers).get("authorization");
						return jsonResponse({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								content: [{ type: "text", text: authorization }],
								isError: false,
							},
						});
					}
					return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	it("executes a server-side local action inline without a worker claim wait", async () => {
		const started = Date.now();
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "local-ok" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: { backend: "local_action", value: "local-ok" },
		});
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("queues destructive local actions for approval", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "needs_approval",
				input: {},
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "pending_approval",
		});
		expect(result).toHaveProperty("approval_url");
	});

	it("executes an upstream MCP tool with the selected connection's credentials and session", async () => {
		const listed = await manageOperations(
			{ action: "list_available", connection_id: mcpConnectionId },
			{} as Env,
			ctx,
		);
		expect(listed).toMatchObject({
			action: "list_available",
			operations: [
				expect.objectContaining({
					operation_key: "remote_echo",
					backend: "mcp_tool",
				}),
			],
		});
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: mcpConnectionId,
				operation_key: "remote_echo",
				input: { value: "mcp" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				content: [
					{
						type: "text",
						text: `Bearer backend-test-token-${mcpConnectionId}`,
					},
				],
			},
		});

		const secondResult = await manageOperations(
			{
				action: "execute",
				connection_id: secondMcpConnectionId,
				operation_key: "remote_echo",
				input: { value: "second-account" },
			},
			{} as Env,
			ctx,
		);
		expect(secondResult).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				content: [
					{
						type: "text",
						text: `Bearer backend-test-token-${secondMcpConnectionId}`,
					},
				],
			},
		});
	});

	it("finalizes an upstream MCP run as failed when transport setup throws", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: mcpConnectionId,
				operation_key: "remote_echo",
				input: { fail_transport: true },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "failed",
			error_message: "upstream transport failed",
		});
		const [run] = await getTestDb()`
			SELECT status, error_message
			FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run).toMatchObject({
			status: "failed",
			error_message: "upstream transport failed",
		});
	});

	it("discovers and executes an OpenAPI HTTP operation", async () => {
		const listed = await manageOperations(
			{ action: "list_available", connection_id: httpConnectionId },
			{} as Env,
			ctx,
		);
		expect(listed).toMatchObject({
			action: "list_available",
			operations: [
				expect.objectContaining({
					operation_key: "create_item",
					backend: "http_operation",
				}),
			],
		});
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "create_item",
				input: { body: { value: "http-ok" } },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				body: { created: true, body: { value: "http-ok" } },
			},
		});
	});
});
