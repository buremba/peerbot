/**
 * SPIKE: grant-on-broker managed OAuth.
 *
 * The grant lives on the BROKER. The broker holds the managed app creds + the
 * user's grant (oauth_account → account row) and runs consent/refresh through
 * its OWN existing flow + CredentialService. The LOCAL instance only fetches a
 * fresh ACCESS token at runtime via `POST /broker/oauth/token`.
 *
 * Proven here without a real external provider:
 *
 *   1. A "broker" org has a connector (whose oauth method `tokenUrl` points at a
 *      LOCAL fake provider), a managed `oauth_app` (fake client_id/secret), an
 *      `oauth_account` profile + `account` row holding an EXPIRING access token
 *      and a refresh token, and a connection wiring them together.
 *   2. `POST /broker/oauth/token` is PAT-gated. A valid PAT for the broker org +
 *      the broker connection id → the broker resolves its managed app + connector
 *      endpoint, REFRESHES the expiring token with its secret (against its own
 *      tokenUrl), and returns ONLY `{ access_token, expires_at }`. The refresh
 *      token + client secret never appear in the response.
 *   3. Scope: a PAT for org B cannot fetch org A's connection token (403). No
 *      PAT → 401, bad PAT → 401, malformed body → 400.
 *   4. End-to-end runtime hook: a LOCAL broker-backed connection (app profile =
 *      a first-class `oauth_broker` profile whose typed fields point broker_url
 *      at the in-process broker server) resolves its access token through the
 *      broker via `resolveExecutionAuth`.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brokerRoutes } from "../../../connect/broker-routes";
import type { Env } from "../../../index";
import { manageAuthProfiles } from "../../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../../tools/registry";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { resolveExecutionAuth } from "../../../utils/execution-context";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestPAT,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

// Canned tokens the fake provider returns on refresh. Distinct from the stored
// (expiring) token so a successful refresh is observable.
const REFRESHED = {
	access_token: "refreshed-access-token-123",
	refresh_token: "broker-refresh-token-456",
	expires_in: 3600,
};
const STALE_ACCESS_TOKEN = "stale-access-token-000";
const BROKER_SECRET = "broker-secret";

// Fake OAuth provider token endpoint the broker org's connector points at.
let providerServer: ReturnType<typeof serve> | null = null;
let providerTokenUrl = "";
let lastRefreshBody: Record<string, string> = {};

// Broker app served on a real port so the local runtime hook's `fetch` reaches it.
let brokerServer: ReturnType<typeof serve> | null = null;
let brokerBaseUrl = "";

function buildBrokerApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/broker", brokerRoutes);
	return app;
}

beforeAll(async () => {
	await initWorkspaceProvider();

	// Fake provider: a refresh_token grant returns canned refreshed tokens. Record
	// the form body so we can assert the broker authed with its own secret.
	const providerApp = new Hono();
	providerApp.post("/token", async (c) => {
		const text = await c.req.text();
		lastRefreshBody = Object.fromEntries(new URLSearchParams(text));
		return c.json({
			access_token: REFRESHED.access_token,
			refresh_token: REFRESHED.refresh_token,
			expires_in: REFRESHED.expires_in,
		});
	});
	providerServer = await new Promise((resolve) => {
		const s = serve(
			{ fetch: providerApp.fetch, hostname: "127.0.0.1", port: 0 },
			(info) => {
				providerTokenUrl = `http://127.0.0.1:${info.port}/token`;
				resolve(s);
			},
		);
	});

	// Broker app on a real port (Env carries DATABASE_URL so handlers hit test DB).
	const brokerApp = buildBrokerApp();
	brokerServer = await new Promise((resolve) => {
		const s = serve(
			{
				fetch: (req: Request) => brokerApp.fetch(req, TEST_ENV),
				hostname: "127.0.0.1",
				port: 0,
			},
			(info) => {
				brokerBaseUrl = `http://127.0.0.1:${info.port}`;
				resolve(s);
			},
		);
	});
});

afterAll(async () => {
	await new Promise<void>((done) =>
		providerServer ? providerServer.close(() => done()) : done(),
	);
	await new Promise<void>((done) =>
		brokerServer ? brokerServer.close(() => done()) : done(),
	);
});

interface SeededConnection {
	orgId: string;
	userId: string;
	/** PAT minted WITH the `broker:token` scope — the authorized happy-path PAT. */
	pat: string;
	/** PAT for the SAME org/user but WITHOUT `broker:token` — must be rejected (403). */
	patNoScope: string;
	connectionId: number;
}

/**
 * Seed a broker org with a managed `oauth_app`, an `oauth_account` grant (an
 * `account` row with an EXPIRING access token + refresh token), a connector
 * whose tokenUrl points at the fake provider, and a connection wiring them. The
 * connector endpoints live in the org's OWN metadata — the broker resolves them
 * server-side; the caller never supplies them.
 */
async function seedBrokerConnection(
	orgName: string,
): Promise<SeededConnection> {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: orgName });
	const user = await createTestUser({ name: `${orgName} Admin` });
	await addUserToOrganization(user.id, org.id, "owner");

	await createTestConnectorDefinition({
		key: "demo.oauth",
		name: "Demo OAuth",
		organization_id: org.id,
		auth_schema: {
			methods: [
				{
					type: "oauth",
					provider: "demo",
					requiredScopes: ["read"],
					authorizationUrl: "https://demo.example/authorize",
					tokenUrl: providerTokenUrl,
					tokenEndpointAuthMethod: "client_secret_post",
					clientIdKey: "DEMO_CLIENT_ID",
					clientSecretKey: "DEMO_CLIENT_SECRET",
				},
			],
		},
		feeds_schema: { items: {} },
	});

	// Managed oauth_app holds the REAL client_id/secret (never leaves the broker).
	const appProfile = await createAuthProfile({
		organizationId: org.id,
		connectorKey: "demo.oauth",
		displayName: "Managed Demo App",
		profileKind: "oauth_app",
		provider: "demo",
		authData: {
			DEMO_CLIENT_ID: "broker-cid",
			DEMO_CLIENT_SECRET: BROKER_SECRET,
		},
	});

	// The grant: an account row with an EXPIRING access token + a refresh token.
	const accountId = `acct_${org.id}`;
	const expiringSoon = new Date(Date.now() + 60 * 1000).toISOString(); // < 5min buffer
	await sql`
    INSERT INTO "account" (
      id, "accountId", "providerId", "userId",
      "accessToken", "refreshToken", "accessTokenExpiresAt",
      scope, "createdAt", "updatedAt"
    ) VALUES (
      ${accountId}, ${accountId}, 'demo', ${user.id},
      ${STALE_ACCESS_TOKEN}, ${"broker-refresh-token-original"}, ${expiringSoon},
      'read', NOW(), NOW()
    )
  `;

	// oauth_account profile pointing at the grant.
	const accountProfile = await createAuthProfile({
		organizationId: org.id,
		connectorKey: "demo.oauth",
		displayName: "Demo Account",
		profileKind: "oauth_account",
		provider: "demo",
		accountId,
	});

	// Connection wiring the grant (auth_profile_id) + managed app (app_auth_profile_id).
	const connRows = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      account_id, auth_profile_id, app_auth_profile_id, created_at, updated_at
    ) VALUES (
      ${org.id}, 'demo.oauth', ${`demo-${org.id}`}, 'Demo Connection', 'active',
      ${accountId}, ${accountProfile.id}, ${appProfile.id}, NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;

	// The broker-ref's PAT carries the least-privilege `broker:token` scope; a
	// sibling PAT for the same org/user WITHOUT it proves org membership alone is
	// insufficient.
	const pat = await createTestPAT(user.id, org.id, { scope: "broker:token" });
	const patNoScope = await createTestPAT(user.id, org.id, {
		scope: "mcp:read mcp:write",
	});
	return {
		orgId: org.id,
		userId: user.id,
		pat: pat.token,
		patNoScope: patNoScope.token,
		connectionId: Number(connRows[0].id),
	};
}

function tokenRequest(
	app: Hono<{ Bindings: Env }>,
	opts: { pat?: string; body?: unknown },
): Promise<Response> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (opts.pat) headers.Authorization = `Bearer ${opts.pat}`;
	return app.fetch(
		new Request("http://broker.local/broker/oauth/token", {
			method: "POST",
			headers,
			body: JSON.stringify(opts.body ?? {}),
		}),
		TEST_ENV,
	);
}

describe("SPIKE: grant-on-broker — POST /broker/oauth/token", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		lastRefreshBody = {};
	});

	it("returns a fresh access token, refreshed server-side with the broker secret", async () => {
		const { pat, connectionId } = await seedBrokerConnection("Broker Org");
		const app = buildBrokerApp();

		const res = await tokenRequest(app, {
			pat,
			body: { connection_id: connectionId },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// The access token is the REFRESHED one — proves the broker refreshed via
		// its own tokenUrl + secret (not the stored stale token).
		expect(body.access_token).toBe(REFRESHED.access_token);
		expect(typeof body.expires_at).toBe("string");

		// The broker authed the refresh with ITS managed client_id/secret.
		expect(lastRefreshBody.client_id).toBe("broker-cid");
		expect(lastRefreshBody.client_secret).toBe(BROKER_SECRET);
		expect(lastRefreshBody.grant_type).toBe("refresh_token");

		// The response leaks NEITHER the refresh token NOR the client secret.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain(REFRESHED.refresh_token);
		expect(serialized).not.toContain("broker-refresh-token-original");
		expect(serialized).not.toContain(BROKER_SECRET);
		expect(body.refresh_token).toBeUndefined();
	});

	it("rejects a cross-org connection (403) — a PAT for org B cannot fetch org A's token", async () => {
		const orgA = await seedBrokerConnection("Org A");
		const orgB = await seedBrokerConnection("Org B");
		const app = buildBrokerApp();

		// Org B's PAT asking for Org A's connection id.
		const res = await tokenRequest(app, {
			pat: orgB.pat,
			body: { connection_id: orgA.connectionId },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("forbidden");
	});

	it("rejects a malformed body (400) — validated, not cast", async () => {
		const { pat } = await seedBrokerConnection("Broker Org");
		const app = buildBrokerApp();

		const res = await tokenRequest(app, {
			pat,
			body: { connection_id: "not-a-number" },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("bad_request");
	});

	it("rejects no PAT (401)", async () => {
		const { connectionId } = await seedBrokerConnection("Broker Org");
		const app = buildBrokerApp();
		const res = await tokenRequest(app, { body: { connection_id: connectionId } });
		expect(res.status).toBe(401);
	});

	it("rejects an invalid PAT (401)", async () => {
		const { connectionId } = await seedBrokerConnection("Broker Org");
		const app = buildBrokerApp();
		const res = await tokenRequest(app, {
			pat: "owl_pat_totally-bogus-token",
			body: { connection_id: connectionId },
		});
		expect(res.status).toBe(401);
	});

	it("rejects a valid org-member PAT WITHOUT the broker:token scope (403)", async () => {
		// Same org + same connection as the happy path, but the PAT carries only
		// `mcp:read mcp:write`. Org membership is not enough — least-privilege.
		const { patNoScope, connectionId } = await seedBrokerConnection("Broker Org");
		const app = buildBrokerApp();
		const res = await tokenRequest(app, {
			pat: patNoScope,
			body: { connection_id: connectionId },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("insufficient_scope");
	});
});

describe("SPIKE: grant-on-broker — local runtime hook", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		lastRefreshBody = {};
	});

	it("a broker-backed local connection resolves its access token via the broker", async () => {
		// Broker side: managed app + grant + connection + PAT (broker.url = the
		// in-process broker server).
		const broker = await seedBrokerConnection("Broker Org");

		// Local side: a separate org whose oauth_app profile is a broker-ref (no
		// local client_id/secret) pointing at the broker connection.
		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Local Org" });
		const localUser = await createTestUser({ name: "Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Local",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [{ type: "oauth", provider: "demo", requiredScopes: ["read"] }],
			},
			feeds_schema: { items: {} },
		});
		const brokerProfile = await createAuthProfile({
			organizationId: localOrg.id,
			connectorKey: "demo.oauth",
			displayName: "Broker-backed Demo App",
			profileKind: "oauth_broker",
			provider: "demo",
			authData: {
				broker_url: brokerBaseUrl,
				broker_org: "broker-org",
				broker_pat: broker.pat,
				broker_connection_id: broker.connectionId,
			},
		});

		// The typed broker fields survive normalization (and there are NO
		// client_id/secret keys and NO `__`-prefixed magic keys on the profile).
		const stored = (await sql`
      SELECT profile_kind, auth_data FROM auth_profiles WHERE id = ${brokerProfile.id}
    `) as unknown as Array<{
			profile_kind: string;
			auth_data: Record<string, unknown>;
		}>;
		expect(stored[0].profile_kind).toBe("oauth_broker");
		expect(stored[0].auth_data.broker_url).toBe(brokerBaseUrl);
		expect(stored[0].auth_data.broker_org).toBe("broker-org");
		expect(stored[0].auth_data.broker_pat).toBe(broker.pat);
		expect(stored[0].auth_data.broker_connection_id).toBe(broker.connectionId);
		expect(stored[0].auth_data.DEMO_CLIENT_ID).toBeUndefined();
		expect(
			Object.keys(stored[0].auth_data).some((k) => k.startsWith("__")),
		).toBe(false);

		// A local connection backed by the broker-ref app profile (no grant locally).
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        app_auth_profile_id, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-local', 'Local Demo', 'active',
        ${brokerProfile.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		// The runtime token-resolution path: detects the broker-ref, fetches the
		// access token from the broker, and returns it as the connection's creds.
		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: brokerProfile.id,
			credentialDb: sql,
		});

		expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
		// No local refresh token / secret ever materialized.
		expect(resolved.credentials?.refreshToken).toBeNull();
		expect(resolved.connectionCredentials).toEqual({});
	});
});

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

describe("oauth_broker profile — create validation via manage_auth_profiles", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	async function seedOrgWithConnector(): Promise<{
		ctx: ToolContext;
		orgId: string;
	}> {
		const org = await createTestOrganization({ name: "Broker Validate Org" });
		const user = await createTestUser({ name: "Broker Validate User" });
		await addUserToOrganization(user.id, org.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth",
			organization_id: org.id,
			auth_schema: {
				methods: [
					{
						type: "oauth",
						provider: "demo",
						requiredScopes: ["read"],
						clientIdKey: "DEMO_CLIENT_ID",
						clientSecretKey: "DEMO_CLIENT_SECRET",
					},
				],
			},
			feeds_schema: { items: {} },
		});
		return { ctx: ctxFor(org.id, user.id), orgId: org.id };
	}

	it("creates an oauth_broker profile when all typed broker fields are present", async () => {
		const { ctx, orgId } = await seedOrgWithConnector();
		const res = await manageAuthProfiles(
			{
				action: "create_auth_profile",
				connector_key: "demo.oauth",
				profile_kind: "oauth_broker",
				display_name: "Broker Ref",
				slug: "broker-ref",
				auth_data: {
					broker_url: "https://broker.lobu.ai",
					broker_org: "broker-org",
					broker_pat: "owl_pat_example",
					broker_connection_id: 42,
				},
			},
			TEST_ENV,
			ctx,
		);
		expect("auth_profile" in res && res.auth_profile).toBeTruthy();
		if ("auth_profile" in res) {
			expect(res.auth_profile.profile_kind).toBe("oauth_broker");
		}

		// Persisted with the typed fields and trailing-slash-normalized URL; the
		// PAT is never echoed back in the serialized profile.
		const sql = getTestDb();
		const rows = (await sql`
      SELECT auth_data FROM auth_profiles
      WHERE organization_id = ${orgId} AND slug = 'broker-ref'
    `) as unknown as Array<{ auth_data: Record<string, unknown> }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].auth_data.broker_connection_id).toBe(42);
		expect(rows[0].auth_data.broker_pat).toBe("owl_pat_example");
		expect(JSON.stringify(res)).not.toContain("owl_pat_example");
	});

	it("rejects an oauth_broker profile missing required fields", async () => {
		const { ctx } = await seedOrgWithConnector();
		const res = await manageAuthProfiles(
			{
				action: "create_auth_profile",
				connector_key: "demo.oauth",
				profile_kind: "oauth_broker",
				display_name: "Incomplete Broker Ref",
				slug: "incomplete-broker-ref",
				// Missing broker_pat + broker_connection_id.
				auth_data: {
					broker_url: "https://broker.lobu.ai",
					broker_org: "broker-org",
				},
			},
			TEST_ENV,
			ctx,
		);
		expect("error" in res).toBe(true);
		if ("error" in res) {
			expect(res.error).toContain("broker_pat");
		}
	});
});
