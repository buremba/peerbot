import { MCP_PROTOCOL_VERSION } from "@lobu/core";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { Env } from "../../../index";
import { manageFeeds } from "../../../tools/admin/manage_feeds";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { seedOwnerContext } from "../../setup/test-fixtures";

const TEST_ENV = {} as Env;
const ATLASSIAN_URL = "https://mcp.atlassian.com/v1/mcp";
const originalFetch = globalThis.fetch;

function jsonResponse(
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("Atlassian MCP feed creation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("resolves a unique site through authenticated MCP and persists routing identity", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(ATLASSIAN_URL);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer rovo-token",
				);
				const body = JSON.parse(String(init?.body)) as {
					id?: unknown;
					method?: string;
					params?: { name?: string };
				};
				if (body.method === "initialize") {
					return jsonResponse(
						{
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: MCP_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: "Atlassian", version: "1.0.0" },
							},
						},
						{ "Mcp-Session-Id": "atlassian-feed-create" },
					);
				}
				if (body.method === "tools/call") {
					expect(body.params?.name).toBe("getAccessibleAtlassianResources");
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify([
										{
											id: "cloud-acme",
											url: "https://acme.atlassian.net",
											name: "Acme",
											scopes: ["read:jira-work"],
										},
									]),
								},
							],
							isError: false,
						},
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
			},
		) as typeof fetch;

		const { org, user, ctx } = await seedOwnerContext({
			orgName: "Atlassian Feed Create Org",
			userName: "Atlassian Feed Create Owner",
		});
		const sql = getTestDb();
		const connectorKey = "mcp.mcp-atlassian-com";
		await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, version, status, auth_schema,
        mcp_config, feeds_schema
      ) VALUES (
        ${org.id}, ${connectorKey}, 'Atlassian', '1.0.0', 'active',
        ${sql.json({
					methods: [{ type: "oauth", provider: connectorKey, required: true }],
				})},
        ${sql.json({ upstream_url: ATLASSIAN_URL, tool_prefix: "mcp_atlassian_com" })},
        ${sql.json({
					issues: {
						key: "issues",
						virtual: true,
						configSchema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				})}
      )
    `;

		const accountId = `atlassian-account-${org.id}`;
		await sql`
      INSERT INTO account (
        id, "accountId", "providerId", "userId", "accessToken",
        "accessTokenExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, ${connectorKey}, ${user.id}, 'rovo-token',
        ${new Date(Date.now() + 3600_000).toISOString()}, NOW(), NOW()
      )
    `;
		const profile = await createAuthProfile({
			organizationId: org.id,
			connectorKey,
			displayName: "Atlassian Account",
			profileKind: "oauth_account",
			provider: connectorKey,
			accountId,
			createdBy: user.id,
		});
		const [connection] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        account_id, auth_profile_id, created_by, visibility
      ) VALUES (
        ${org.id}, ${connectorKey}, 'atlassian-rovo', 'Atlassian', 'active',
        ${accountId}, ${profile.id}, ${user.id}, 'private'
      )
      RETURNING id
    `;

		const result = (await manageFeeds(
			{
				action: "create_feed",
				connection_id: Number(connection.id),
				feed_key: "issues",
				config: { query: "project = ACME" },
			},
			TEST_ENV,
			ctx,
		)) as { error?: string; feed?: { config: Record<string, unknown> } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.config).toMatchObject({
			query: "project = ACME",
			cloud_id: "cloud-acme",
			site_cloud_id: "cloud-acme",
			site_url: "https://acme.atlassian.net",
			site_name: "Acme",
		});
		const [configured] = await sql`
      SELECT external_tenant_id, config
      FROM connections
      WHERE id = ${connection.id} AND organization_id = ${org.id}
    `;
		expect(configured.external_tenant_id).toBe("cloud-acme");
		expect(configured.config).toMatchObject({
			cloud_id: "cloud-acme",
			site_url: "https://acme.atlassian.net",
		});
	});
});
