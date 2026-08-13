import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../../index.js";
import type { ToolContext } from "../../tools/registry.js";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-atlassian-webhook";
const AGENT = "agent-atlassian-webhook";
const USER = "user-atlassian-webhook";
const ADMIN_ONLY_ERROR =
	"Only admins can configure the secondary Jira authorization used by Atlassian webhook delivery.";

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
	await seedAgentRow(AGENT, { organizationId: ORG });
});

function memberContext(): ToolContext {
	return {
		organizationId: ORG,
		userId: USER,
		memberRole: "member",
		agentId: AGENT,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as ToolContext;
}

async function seedConfiguredConnection(options?: {
	memberRole?: "member";
}): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const { createAuthProfile } = await import("../../utils/auth-profiles.js");
	const { persistAuthCredentials } = await import(
		"../../utils/auth-credential-secrets.js"
	);
	const sql = getDb();
	await sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		VALUES (${USER}, 'Owner', 'owner-atlassian-webhook@example.com', true, NOW(), NOW())
	`;
	if (options?.memberRole) {
		await sql`
			INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
			VALUES ('member-atlassian-webhook', ${ORG}, ${USER}, ${options.memberRole}, NOW())
		`;
	}
	await sql`
		INSERT INTO connector_definitions (
			organization_id, key, name, version, status, mcp_config, feeds_schema
		) VALUES (
			${ORG}, 'mcp.mcp-atlassian-com', 'Atlassian', '1.0.0', 'active',
			${sql.json({ upstream_url: "https://mcp.atlassian.com/v1/mcp" })},
			${sql.json({ issues: { key: "issues", virtual: true } })}
		)
	`;
	const accountId = "jira-webhook-account";
	await sql`
		INSERT INTO account (
			id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
			"accessTokenExpiresAt", scope, "createdAt", "updatedAt"
		) VALUES (
			${accountId}, ${accountId}, 'jira', ${USER}, 'jira-access-token',
			'jira-refresh-token', ${new Date(Date.now() + 3_600_000).toISOString()},
			'read:jira-work manage:jira-webhook offline_access', NOW(), NOW()
		)
	`;
	const accountProfile = await createAuthProfile({
		organizationId: ORG,
		connectorKey: "jira",
		displayName: "Jira Webhook Account",
		slug: "jira-webhook-account",
		profileKind: "oauth_account",
		status: "active",
		provider: "jira",
		accountId,
		createdBy: USER,
	});
	const appProfile = await createAuthProfile({
		organizationId: ORG,
		connectorKey: "jira",
		displayName: "Jira Webhook App",
		slug: "jira-webhook-app",
		profileKind: "oauth_app",
		status: "active",
		provider: "jira",
		createdBy: USER,
	});
	await persistAuthCredentials({
		organizationId: ORG,
		authProfileId: appProfile.id,
		credentials: {
			JIRA_CLIENT_ID: "jira-client-id",
			JIRA_CLIENT_SECRET: "jira-client-secret",
		},
	});
	const [connection] = await sql`
		INSERT INTO connections (
			organization_id, connector_key, slug, display_name, status, visibility,
			created_by, config
		) VALUES (
			${ORG}, 'mcp.mcp-atlassian-com', 'atlassian-rovo', 'Atlassian', 'active',
			'private', ${USER}, ${sql.json({
				cloud_id: "cloud-1",
				site_url: "https://acme.atlassian.net",
				webhook_enabled: true,
				jira_webhook_auth_profile_slug: accountProfile.slug,
				jira_webhook_app_profile_slug: appProfile.slug,
			})}
		)
		RETURNING id
	`;
	return Number(connection.id);
}

describe("Atlassian MCP Jira dynamic webhooks", () => {
	test("rejects secondary Jira webhook credentials from a member on create", async () => {
		await seedConfiguredConnection({ memberRole: "member" });
		const { manageConnections } = await import(
			"../../tools/admin/manage_connections.js"
		);
		const result = await manageConnections(
			{
				action: "create",
				connector_key: "mcp.mcp-atlassian-com",
				slug: "member-atlassian-create",
				display_name: "Member Atlassian",
				config: {
					webhook_enabled: true,
					jira_webhook_auth_profile_slug: "jira-webhook-account",
					jira_webhook_app_profile_slug: "jira-webhook-app",
				},
			},
			{} as Env,
			memberContext(),
		);
		expect(result).toEqual({ error: ADMIN_ONLY_ERROR });
		const { getDb } = await import("../../db/client.js");
		const [row] = await getDb()`
			SELECT count(*)::int AS count FROM connections
			WHERE organization_id = ${ORG} AND slug = 'member-atlassian-create'
		`;
		expect(row.count).toBe(0);
	});

	test("rejects secondary Jira webhook credentials from a member on update", async () => {
		const connectionId = await seedConfiguredConnection({
			memberRole: "member",
		});
		const { getDb } = await import("../../db/client.js");
		const [before] = await getDb()`
			SELECT config FROM connections WHERE id = ${connectionId}
		`;
		const { manageConnections } = await import(
			"../../tools/admin/manage_connections.js"
		);
		const result = await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				config: { webhook_enabled: false },
			},
			{} as Env,
			memberContext(),
		);
		expect(result).toEqual({ error: ADMIN_ONLY_ERROR });
		const [after] = await getDb()`
			SELECT config FROM connections WHERE id = ${connectionId}
		`;
		expect(after.config).toEqual(before.config);
	});

	test("registers an authenticated per-connection webhook and persists verification state", async () => {
		const connectionId = await seedConfiguredConnection();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			requests.push({ url, init });
			if (init?.method === "GET") {
				return Response.json({ values: [] });
			}
			return Response.json({
				webhookRegistrationResult: [{ createdWebhookId: 123 }],
			});
		};
		const { ensureAtlassianMcpJiraWebhook } = await import(
			"../../connect/atlassian-mcp-webhook.js"
		);
		await ensureAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			fetchImpl,
		});

		expect(requests).toHaveLength(2);
		expect(requests[0].init?.headers).toMatchObject({
			Authorization: "Bearer jira-access-token",
		});
		const body = JSON.parse(String(requests[1].init?.body));
		const callback = new URL(body.url);
		expect(`${callback.origin}${callback.pathname}`).toBe(
			`https://lobu.example.com/api/v1/webhooks/${connectionId}`,
		);
		expect(callback.searchParams.get("token")?.length).toBeGreaterThanOrEqual(
			32,
		);
		expect(body.webhooks[0].events).toEqual([
			"jira:issue_created",
			"jira:issue_updated",
			"comment_created",
		]);
		expect(body.secret).toBeUndefined();

		const { getDb } = await import("../../db/client.js");
		const [row] = await getDb()`
			SELECT config FROM connections
			WHERE id = ${connectionId} AND organization_id = ${ORG}
		`;
		expect(row.config).toMatchObject({
			webhook_external_id: "123",
			webhook_status: "active",
		});
		expect(String(row.config.webhook_callback_token)).toStartWith("secret://");
		expect(
			new Date(String(row.config.webhook_expires_at)).getTime(),
		).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
	});

	test("refreshes a due subscription without registering a duplicate", async () => {
		const connectionId = await seedConfiguredConnection();
		const { ensureAtlassianMcpJiraWebhook } = await import(
			"../../connect/atlassian-mcp-webhook.js"
		);
		const firstNow = new Date("2026-08-13T12:00:00.000Z");
		let registeredUrl = "";
		await ensureAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			now: firstNow,
			fetchImpl: async (_input, init) => {
				if (init?.method === "GET") return Response.json({ values: [] });
				registeredUrl = JSON.parse(String(init?.body)).url;
				return Response.json({
					webhookRegistrationResult: [{ createdWebhookId: 123 }],
				});
			},
		});
		const methods: string[] = [];
		const secondNow = new Date("2026-09-08T12:00:00.000Z");
		const refreshedExpiry = "2026-10-08T12:00:00.000Z";
		await ensureAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			now: secondNow,
			fetchImpl: async (_input, init) => {
				methods.push(String(init?.method));
				return init?.method === "GET"
					? Response.json({
							values: [
								{
									id: 123,
									url: registeredUrl,
									expirationDate: "2026-09-09T12:00:00.000Z",
								},
							],
						})
					: Response.json({ expirationDate: refreshedExpiry });
			},
		});
		expect(methods).toEqual(["GET", "PUT"]);
		const { getDb } = await import("../../db/client.js");
		const [row] =
			await getDb()`SELECT config FROM connections WHERE id = ${connectionId}`;
		expect(row.config.webhook_external_id).toBe("123");
		expect(row.config.webhook_expires_at).toBe(refreshedExpiry);
	});

	test("reconciles ambiguous provider state before clearing the local callback token", async () => {
		const connectionId = await seedConfiguredConnection();
		const { ensureAtlassianMcpJiraWebhook, unregisterAtlassianMcpJiraWebhook } =
			await import("../../connect/atlassian-mcp-webhook.js");
		let registeredUrl = "";
		await ensureAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			fetchImpl: async (_input, init) => {
				if (init?.method === "GET") return Response.json({ values: [] });
				registeredUrl = JSON.parse(String(init?.body)).url;
				return Response.json({
					webhookRegistrationResult: [{ createdWebhookId: 123 }],
				});
			},
		});
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			UPDATE connections
			SET config = config - 'webhook_external_id'
			WHERE id = ${connectionId}
		`;
		let deleteBody: unknown;
		await unregisterAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			fetchImpl: async (_input, init) => {
				if (init?.method === "GET") {
					return Response.json({
						values: [{ id: 123, url: registeredUrl }],
						isLast: true,
					});
				}
				deleteBody = JSON.parse(String(init?.body));
				return Response.json({});
			},
		});
		expect(deleteBody).toEqual({ webhookIds: [123] });
		const [row] =
			await getDb()`SELECT config FROM connections WHERE id = ${connectionId}`;
		expect(row.config.webhook_external_id).toBeUndefined();
		expect(row.config.webhook_callback_token).toBeUndefined();
		const [secrets] = await getDb()`
			SELECT count(*)::int AS count
			FROM agent_secrets
			WHERE organization_id = ${ORG}
			  AND name = ${`webhook/${connectionId}/callback-token`}
		`;
		expect(secrets.count).toBe(0);
	});

	test("teardown of a never-registered connection skips provider inspection", async () => {
		// webhook_enabled=true but registration never ran (no external id, no
		// callback token, no orphan secret) — teardown must not demand provider
		// prerequisites like a resolved cloud_id, or the connection could never
		// be disabled or deleted.
		const connectionId = await seedConfiguredConnection();
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			UPDATE connections
			SET config = config - 'cloud_id'
			WHERE id = ${connectionId}
		`;
		let fetchCalls = 0;
		const { unregisterAtlassianMcpJiraWebhook } = await import(
			"../../connect/atlassian-mcp-webhook.js"
		);
		const result = await unregisterAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			fetchImpl: async () => {
				fetchCalls += 1;
				return Response.json({});
			},
		});
		expect(fetchCalls).toBe(0);
		expect(result).toEqual({ handled: true, changed: false, status: "disabled" });
	});

	test("an orphaned callback-token secret forces provider reconciliation on teardown", async () => {
		// Crash window: the registration tx persists the callback-token secret
		// outside itself, then rolls back the config write. The secret row is the
		// only durable trace that the provider may hold a webhook — teardown must
		// inspect and delete it.
		const connectionId = await seedConfiguredConnection();
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { PostgresSecretStore } = await import(
			"../../lobu/stores/postgres-secret-store.js"
		);
		await orgContext.run({ organizationId: ORG }, () =>
			new PostgresSecretStore().put(
				`webhook/${connectionId}/callback-token`,
				"orphaned-token",
			),
		);
		const requests: string[] = [];
		let deleteBody: unknown;
		const { unregisterAtlassianMcpJiraWebhook } = await import(
			"../../connect/atlassian-mcp-webhook.js"
		);
		await unregisterAtlassianMcpJiraWebhook({
			organizationId: ORG,
			connectionId,
			baseUrl: "https://lobu.example.com",
			fetchImpl: async (_input, init) => {
				requests.push(String(init?.method));
				if (init?.method === "GET") {
					return Response.json({
						values: [
							{
								id: 77,
								url: `https://lobu.example.com/api/v1/webhooks/${connectionId}?token=orphaned-token`,
							},
						],
						isLast: true,
					});
				}
				deleteBody = JSON.parse(String(init?.body));
				return Response.json({});
			},
		});
		expect(requests).toEqual(["GET", "DELETE"]);
		expect(deleteBody).toEqual({ webhookIds: [77] });
		const { getDb } = await import("../../db/client.js");
		const [secrets] = await getDb()`
			SELECT count(*)::int AS count
			FROM agent_secrets
			WHERE organization_id = ${ORG}
			  AND name = ${`webhook/${connectionId}/callback-token`}
		`;
		expect(secrets.count).toBe(0);
	});

	test("fails closed and records a visible error when webhook consent is missing", async () => {
		const connectionId = await seedConfiguredConnection();
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			UPDATE account
			SET scope = 'read:jira-work offline_access'
			WHERE id = 'jira-webhook-account'
		`;
		let fetchCalls = 0;
		const { ensureAtlassianMcpJiraWebhook } = await import(
			"../../connect/atlassian-mcp-webhook.js"
		);
		await expect(
			ensureAtlassianMcpJiraWebhook({
				organizationId: ORG,
				connectionId,
				baseUrl: "https://lobu.example.com",
				fetchImpl: async () => {
					fetchCalls += 1;
					return Response.json({});
				},
			}),
		).rejects.toThrow("missing manage:jira-webhook consent");
		expect(fetchCalls).toBe(0);
		const [row] =
			await getDb()`SELECT config FROM connections WHERE id = ${connectionId}`;
		expect(row.config).toMatchObject({
			webhook_status: "error",
		});
		expect(String(row.config.webhook_error)).toContain(
			"missing manage:jira-webhook consent",
		);
	});
});
