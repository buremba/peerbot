import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SecretRef } from "@lobu/core";
import { orgContext, tryGetOrgId } from "../../lobu/stores/org-context.js";
import { completeAuthCodeFlow } from "../auth/mcp/oauth-flow.js";
import { OAuthStateStore } from "../auth/oauth/state-store.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

class OrgScopedWritableStore implements WritableSecretStore {
	private readonly entries = new Map<string, string>();

	constructor(private readonly organizationId: string) {}

	async get(ref: SecretRef): Promise<string | null> {
		if (tryGetOrgId() !== this.organizationId) return null;
		if (!ref.startsWith("secret://")) return null;
		const name = decodeURIComponent(ref.slice("secret://".length));
		return this.entries.get(name) ?? null;
	}

	async put(name: string, value: string): Promise<SecretRef> {
		if (tryGetOrgId() !== this.organizationId) {
			throw new Error("test secret write missing org context");
		}
		this.entries.set(name, value);
		return `secret://${encodeURIComponent(name)}` as SecretRef;
	}

	async delete(nameOrRef: string): Promise<void> {
		if (tryGetOrgId() !== this.organizationId) {
			throw new Error("test secret delete missing org context");
		}
		const name = nameOrRef.startsWith("secret://")
			? decodeURIComponent(nameOrRef.slice("secret://".length))
			: nameOrRef;
		this.entries.delete(name);
	}

	async list(prefix?: string): Promise<SecretListEntry[]> {
		if (tryGetOrgId() !== this.organizationId) return [];
		return Array.from(this.entries.keys())
			.filter((name) => !prefix || name.startsWith(prefix))
			.map((name) => ({
				ref: `secret://${encodeURIComponent(name)}` as SecretRef,
				backend: "memory",
				name,
				updatedAt: Date.now(),
			}));
	}
}

const MCP_OAUTH_STATE_PREFIX = "mcp-oauth:state";

function mcpOAuthStateStore(): OAuthStateStore<Record<string, unknown>> {
	return new OAuthStateStore(MCP_OAUTH_STATE_PREFIX, "mcp-oauth-state-test");
}

describe("MCP OAuth org context", () => {
	const originalFetch = globalThis.fetch;

	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("callback stores credentials in the organization persisted in OAuth state", async () => {
		const orgId = "org-oauth-callback-test";
		const agentId = "agent-oauth";
		const userId = "user-oauth";
		const mcpId = "oauth-mcp";
		const store = new OrgScopedWritableStore(orgId);
		const state = await mcpOAuthStateStore().create({
			userId,
			agentId,
			organizationId: orgId,
			codeVerifier: "verifier",
			mcpId,
			scopeKey: userId,
			endpoints: { tokenEndpoint: "https://issuer.example/oauth/token" },
			client: { clientId: "client-id", tokenEndpointAuthMethod: "none" },
			platform: "slack",
			channelId: "channel",
			conversationId: "conversation",
		});
		globalThis.fetch = async () =>
			Response.json({
				access_token: "oauth-access-token",
				refresh_token: "oauth-refresh-token",
				expires_in: 3600,
			});

		await completeAuthCodeFlow({
			secretStore: store,
			state,
			code: "code",
			redirectUri: "https://gateway.example/mcp/oauth/callback",
		});

		const credential = await orgContext.run({ organizationId: orgId }, () =>
			store.get(
				`secret://${encodeURIComponent(
					`mcp-auth/${agentId}/${userId}/${mcpId}/credential`,
				)}` as SecretRef,
			),
		);
		expect(JSON.parse(credential ?? "{}").accessToken).toBe(
			"oauth-access-token",
		);
	});

	test("callback rejects OAuth state missing organizationId before token exchange", async () => {
		const store = new OrgScopedWritableStore("org-oauth-callback-test");
		const state = await mcpOAuthStateStore().create({
			userId: "user-oauth",
			agentId: "agent-oauth",
			codeVerifier: "verifier",
			mcpId: "oauth-mcp",
			scopeKey: "user-oauth",
			endpoints: { tokenEndpoint: "https://issuer.example/oauth/token" },
			client: { clientId: "client-id", tokenEndpointAuthMethod: "none" },
			platform: "slack",
			channelId: "channel",
			conversationId: "conversation",
		});
		const fetchMock = mock(() =>
			Response.json({
				access_token: "oauth-access-token",
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			completeAuthCodeFlow({
				secretStore: store,
				state,
				code: "code",
				redirectUri: "https://gateway.example/mcp/oauth/callback",
			}),
		).rejects.toThrow("OAuth state missing organizationId");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});