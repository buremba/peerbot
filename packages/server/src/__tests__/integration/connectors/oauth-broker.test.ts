/**
 * SPIKE: broker-delegated oauth_app profiles.
 *
 * Proves the local↔broker AUTH handshake for Nango-style managed OAuth without
 * a real external provider:
 *
 *   1. A "broker" org holds a managed `oauth_app` (fake client_id/secret) for a
 *      test connector whose oauth method's `tokenUrl`/`authorizationUrl` point
 *      at a LOCAL fake provider server that returns canned tokens. Those
 *      endpoints live in the broker org's OWN connector metadata — the broker
 *      resolves them SERVER-SIDE; the caller never supplies them.
 *   2. The broker's `POST /broker/oauth/exchange` is PAT-gated. A valid PAT for
 *      the broker org → the broker resolves ITS managed app + ITS connector
 *      endpoints, uses the secret, and returns ONLY the user's tokens. No /
 *      invalid PAT → 401.
 *   3. A caller-supplied `token_url` in the body is IGNORED (the broker hits
 *      its own connector's tokenUrl), so the client_secret can never be
 *      redirected to an attacker.
 *   4. End-to-end: a LOCAL connect token whose oauth_app profile is a
 *      `__broker` ref drives `GET /connect/oauth/callback`; the callback
 *      delegates the code exchange to the broker (broker.url = self) and stores
 *      the broker-returned tokens on the `account` row — never touching a local
 *      client_secret.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brokerRoutes } from "../../../connect/broker-routes";
import { connectRoutes } from "../../../connect/routes";
import type { Env } from "../../../index";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { createConnectToken } from "../../../utils/connect-tokens";
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

const CANNED = {
	access_token: "canned-access-token-123",
	refresh_token: "canned-refresh-token-456",
	expires_in: 3600,
	scope: "read write",
	token_type: "Bearer",
};

// Fake OAuth provider: the tokenUrl the broker org's connector points at. A
// SECOND fake server stands in for an "attacker" endpoint — if the broker ever
// honored a caller-supplied token_url it would POST the client_secret here.
let providerServer: ReturnType<typeof serve> | null = null;
let providerTokenUrl = "";
let attackerServer: ReturnType<typeof serve> | null = null;
let attackerTokenUrl = "";
let attackerHits = 0;

// Broker app served on a real port so the local callback's `fetch` reaches it.
let brokerServer: ReturnType<typeof serve> | null = null;
let brokerBaseUrl = "";

function buildBrokerApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/broker", brokerRoutes);
	return app;
}

beforeAll(async () => {
	await initWorkspaceProvider();

	// Fake provider token endpoint — returns canned tokens for any code.
	const providerApp = new Hono();
	providerApp.post("/token", (c) => c.json(CANNED));
	providerServer = await new Promise((resolve) => {
		const s = serve(
			{ fetch: providerApp.fetch, hostname: "127.0.0.1", port: 0 },
			(info) => {
				providerTokenUrl = `http://127.0.0.1:${info.port}/token`;
				resolve(s);
			},
		);
	});

	// "Attacker" endpoint — records any hit. Must stay at 0 hits.
	const attackerApp = new Hono();
	attackerApp.post("/token", (c) => {
		attackerHits += 1;
		return c.json(CANNED);
	});
	attackerServer = await new Promise((resolve) => {
		const s = serve(
			{ fetch: attackerApp.fetch, hostname: "127.0.0.1", port: 0 },
			(info) => {
				attackerTokenUrl = `http://127.0.0.1:${info.port}/token`;
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
		attackerServer ? attackerServer.close(() => done()) : done(),
	);
	await new Promise<void>((done) =>
		brokerServer ? brokerServer.close(() => done()) : done(),
	);
});

/**
 * Seed a broker org with a managed oauth_app (fake creds) for `demo`. The
 * connector's auth_schema carries the OAuth endpoints — the broker resolves
 * `tokenUrl`/`authorizationUrl` from HERE, not from the request.
 */
async function seedBrokerOrg() {
	const org = await createTestOrganization({ name: "Broker Org" });
	const user = await createTestUser({ name: "Broker Admin" });
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
					clientIdKey: "DEMO_CLIENT_ID",
					clientSecretKey: "DEMO_CLIENT_SECRET",
				},
			],
		},
		feeds_schema: { items: {} },
	});
	// Managed oauth_app holds the REAL client_id/secret (never leaves the broker).
	await createAuthProfile({
		organizationId: org.id,
		connectorKey: "demo.oauth",
		displayName: "Managed Demo App",
		slug: "managed-demo",
		profileKind: "oauth_app",
		provider: "demo",
		authData: {
			DEMO_CLIENT_ID: "broker-cid",
			DEMO_CLIENT_SECRET: "broker-secret",
		},
	});
	const pat = await createTestPAT(user.id, org.id);
	return { org, user, pat };
}

describe("SPIKE: broker-delegated oauth_app — exchange handshake", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		attackerHits = 0;
	});

	it("PAT-gated exchange resolves the broker managed app + connector endpoint and returns user tokens", async () => {
		const { pat } = await seedBrokerOrg();
		const app = buildBrokerApp();

		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${pat.token}`,
				},
				body: JSON.stringify({
					connector_key: "demo.oauth",
					provider: "demo",
					code: "auth-code-abc",
					redirect_uri: "http://local.example/connect/oauth/callback",
				}),
			}),
			TEST_ENV,
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.access_token).toBe(CANNED.access_token);
		expect(body.refresh_token).toBe(CANNED.refresh_token);
		expect(body.expires_in).toBe(CANNED.expires_in);
		expect(body.scope).toBe(CANNED.scope);
		// The broker never leaks the client_secret back to the caller.
		expect(JSON.stringify(body)).not.toContain("broker-secret");
	});

	it("ignores a caller-supplied token_url — secret can NOT be redirected to an attacker", async () => {
		const { pat } = await seedBrokerOrg();
		const app = buildBrokerApp();

		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${pat.token}`,
				},
				body: JSON.stringify({
					connector_key: "demo.oauth",
					provider: "demo",
					code: "auth-code-abc",
					redirect_uri: "http://local.example/connect/oauth/callback",
					// Malicious: try to redirect the secret-bearing exchange elsewhere.
					token_url: attackerTokenUrl,
					token_endpoint_auth_method: "client_secret_basic",
					client_secret_key: "DEMO_CLIENT_SECRET",
				}),
			}),
			TEST_ENV,
		);

		// The broker hits ITS OWN connector's tokenUrl and returns canned tokens;
		// the attacker endpoint is never touched.
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.access_token).toBe(CANNED.access_token);
		expect(attackerHits).toBe(0);
	});

	it("rejects exchange for a connector the broker org does not manage (400)", async () => {
		const { pat } = await seedBrokerOrg();
		const app = buildBrokerApp();
		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${pat.token}`,
				},
				body: JSON.stringify({
					connector_key: "not.a.real.connector",
					provider: "demo",
					code: "x",
					redirect_uri: "http://local.example/cb",
				}),
			}),
			TEST_ENV,
		);
		expect(res.status).toBe(400);
		expect(attackerHits).toBe(0);
	});

	it("rejects a malformed body — missing required fields — with 400 (validated, not cast)", async () => {
		const { pat } = await seedBrokerOrg();
		const app = buildBrokerApp();
		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${pat.token}`,
				},
				// Missing `code` and `redirect_uri` — must 400 before any resolution.
				body: JSON.stringify({ connector_key: "demo.oauth", provider: "demo" }),
			}),
			TEST_ENV,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("bad_request");
		expect(attackerHits).toBe(0);
	});

	it("rejects exchange with no PAT (401)", async () => {
		await seedBrokerOrg();
		const app = buildBrokerApp();
		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					connector_key: "demo.oauth",
					provider: "demo",
					code: "x",
					redirect_uri: "http://local.example/cb",
				}),
			}),
			TEST_ENV,
		);
		expect(res.status).toBe(401);
	});

	it("rejects exchange with an invalid PAT (401)", async () => {
		await seedBrokerOrg();
		const app = buildBrokerApp();
		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer owl_pat_totally-bogus-token",
				},
				body: JSON.stringify({
					connector_key: "demo.oauth",
					provider: "demo",
					code: "x",
					redirect_uri: "http://local.example/cb",
				}),
			}),
			TEST_ENV,
		);
		expect(res.status).toBe(401);
	});

	it("authorize-url builds the provider consent URL with the broker client_id + server-resolved endpoint", async () => {
		const { pat } = await seedBrokerOrg();
		const app = buildBrokerApp();
		const res = await app.fetch(
			new Request("http://broker.local/broker/oauth/authorize-url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${pat.token}`,
				},
				body: JSON.stringify({
					connector_key: "demo.oauth",
					provider: "demo",
					redirect_uri: "http://local.example/connect/oauth/callback",
					scopes: ["read"],
					state: "state-xyz",
				}),
			}),
			TEST_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorization_url: string };
		const url = new URL(body.authorization_url);
		// Endpoint comes from the broker org's connector metadata, not the request.
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://demo.example/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe("broker-cid");
		expect(url.searchParams.get("state")).toBe("state-xyz");
	});
});

describe("SPIKE: broker-delegated oauth_app — end-to-end local delegation", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		attackerHits = 0;
	});

	it("local callback delegates code exchange to the broker and stores broker tokens", async () => {
		// Broker side: managed app + connector endpoints + PAT (broker.url = the
		// in-process broker server).
		const { pat } = await seedBrokerOrg();

		// Local side: a separate org whose oauth_app profile is a broker-ref (no
		// local client_id/secret) plus a connect token bound to it.
		const localOrg = await createTestOrganization({ name: "Local Org" });
		const localUser = await createTestUser({ name: "Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Local",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [
					{ type: "oauth", provider: "demo", requiredScopes: ["read"] },
				],
			},
			feeds_schema: { items: {} },
		});
		const brokerProfile = await createAuthProfile({
			organizationId: localOrg.id,
			connectorKey: "demo.oauth",
			displayName: "Broker-backed Demo App",
			slug: "local-broker-app",
			profileKind: "oauth_app",
			provider: "demo",
			authData: {
				__broker: { url: brokerBaseUrl, org: "broker-org", pat: pat.token },
			},
		});

		// The broker-ref must survive normalization (no client_id/secret keys).
		const sql = getTestDb();
		const stored = (await sql`
      SELECT auth_data FROM auth_profiles WHERE id = ${brokerProfile.id}
    `) as unknown as Array<{ auth_data: Record<string, unknown> }>;
		expect(
			(stored[0].auth_data as { __broker?: unknown }).__broker,
		).toBeTruthy();
		expect(stored[0].auth_data.DEMO_CLIENT_ID).toBeUndefined();

		// Connect token (oauth) bound to the local broker-ref app profile. The
		// local instance has NO tokenUrl/secret — the broker resolves the endpoint
		// server-side. created_by set so the callback skips session lookup.
		const tokenRow = await createConnectToken({
			organizationId: localOrg.id,
			connectorKey: "demo.oauth",
			authType: "oauth",
			authConfig: {
				provider: "demo",
				scopes: ["read"],
				redirectUri: "http://local.example/connect/oauth/callback",
				clientIdKey: "DEMO_CLIENT_ID",
				clientSecretKey: "DEMO_CLIENT_SECRET",
			},
			createdBy: localUser.id,
		});

		// Drive the stable callback. The local instance has no client_secret; it
		// POSTs the broker /exchange (which uses the broker's secret + endpoint)
		// and stores the broker-returned tokens.
		const app = new Hono<{ Bindings: Env }>();
		app.route("/connect", connectRoutes);
		const res = await app.fetch(
			new Request(
				`http://local.example/connect/oauth/callback?state=${tokenRow.token}&code=auth-code-e2e`,
				{ method: "GET", redirect: "manual" },
			),
			TEST_ENV,
		);
		// Callback ends in a redirect (302) once tokens are stored.
		expect(res.status).toBe(302);

		// The account row must carry the broker-returned canned tokens — proof the
		// exchange was delegated and no local secret was needed.
		const accounts = (await sql`
      SELECT "accessToken", "refreshToken", "providerId"
      FROM "account"
      WHERE "userId" = ${localUser.id} AND "providerId" = 'demo'
    `) as unknown as Array<{
			accessToken: string;
			refreshToken: string;
			providerId: string;
		}>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accessToken).toBe(CANNED.access_token);
		expect(accounts[0].refreshToken).toBe(CANNED.refresh_token);

		// Connect token consumed.
		const tk = (await sql`
      SELECT status FROM connect_tokens WHERE token = ${tokenRow.token}
    `) as unknown as Array<{ status: string }>;
		expect(tk[0].status).toBe("completed");
	});
});
