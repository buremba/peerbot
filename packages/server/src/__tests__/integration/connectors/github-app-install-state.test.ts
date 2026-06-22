/**
 * GitHub App install callback — CSRF / cross-tenant guard (signed state).
 *
 * The `/github/app/install/callback` route is a public, unauthenticated GET that
 * mutates org state (writes an `app_installations` row + a `github` connection).
 * Without a verified `state`, a forged GET could plant a connection into a
 * victim's org (CSRF) or cross-tenant. This suite proves:
 *
 *   1. a callback with NO `state` is rejected (4xx) and writes NOTHING,
 *   2. a callback with an INVALID/forged `state` is rejected (4xx) and writes
 *      NOTHING,
 *   3. the `GET /github/app/install` start route mints a signed state bound to
 *      the initiating org, and the callback carrying that state succeeds and
 *      binds the install to the STATE's org — never the ambient callback session,
 *   4. the state is single-use (replay of a consumed state is rejected).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
	type AppInstallRouterDeps,
	autoProvisionGithubIssueFeeds,
	createAppInstallRoutes,
} from "../../../gateway/routes/public/app-install";
import { createGithubInstallStateStore } from "../../../gateway/auth/oauth/state-store";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import {
	__resetInstallationTokenRegistryForTests,
	getInstallationTokenRegistry,
} from "../../../gateway/installation/registry";
import { getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	createTestConnectorDefinition,
	createTestOrganization,
} from "../../setup/test-fixtures";

const CONNECTOR_KEY = "github";
const PROVIDER_APP_ID = "test-github-app-state";
const APP_SLUG = "lobu-test-app";

async function seedGithubConnector(organizationId: string): Promise<void> {
	await createTestConnectorDefinition({
		key: CONNECTOR_KEY,
		name: "GitHub",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "app_installation",
					provider: "github",
					providerInstance: "cloud",
					appIdKey: "GITHUB_APP_ID",
					privateKeyKey: "GITHUB_APP_PRIVATE_KEY",
				},
			],
		},
		feeds_schema: { issues: {} },
	});
}

/** A mocked GitHub account that owns an installation the authed user can see. */
type MockAccount = { login: string; type: "User" | "Organization" };

/**
 * Build the install router. ALL GitHub HTTP calls (OAuth code exchange,
 * `/user/installations`, `/user`, `/user/memberships/orgs/{org}`) are mocked via
 * DI so tests NEVER hit real GitHub. Options:
 *  - `installations`: map of installation_id → owning account the (mocked)
 *    `/user/installations` reports. Pass `null` to simulate an HTTP failure
 *    (returns undefined → "cannot verify").
 *  - `authedLogin`: the login `/user` returns (defaults to "installer-user").
 *  - `orgRoles`: map of org-login → membership `{state, role}` returned by
 *    `/user/memberships/orgs/{org}`. Missing org → non-member (state:none).
 *    Pass `null` to simulate an HTTP failure for the membership call.
 *  - `exchangeReturns`: user token the (mocked) exchange yields; `null` =
 *    failed exchange. Defaults to a fake token.
 *  - `ownedInstallationIds` (shorthand): personal-account installs owned by
 *    `authedLogin` — convenience for the simpler cases.
 */
/** Captures what the mocked OAuth exchange was called with (for assertions). */
interface RouterCapture {
	exchangeRedirectUri?: string;
	exchangeCalls: number;
	/** feed ids passed to the (mocked) sync-run enqueue. */
	enqueuedFeedIds: number[];
	/** installation tokens the (mocked) repo enumeration was called with. */
	repoFetchTokens: string[];
}

const PUBLIC_GATEWAY_URL = "https://app.lobu.ai";

function buildRouter(
	installOrgId: string | null,
	opts: {
		installations?: Record<number, MockAccount> | null;
		ownedInstallationIds?: number[];
		authedLogin?: string;
		orgRoles?: Record<string, { state: string; role: string }> | null;
		exchangeReturns?: string | null;
		/** Public gateway base for redirect_uri; defaults to PUBLIC_GATEWAY_URL. */
		publicGatewayUrl?: string | undefined;
		/**
		 * Recovery: the sole ACCESSIBLE installation the (mocked) /user/installations
		 * recovery lookup returns. `null`/`"ambiguous"`/`undefined` map to the
		 * respective recovery outcomes. When omitted, the recovery lookup derives
		 * from `installations`/`ownedInstallationIds` (sole entry → that install;
		 * >1 → ambiguous; 0 → null).
		 */
		soleInstallation?:
			| { installationId: number; account: MockAccount }
			| null
			| "ambiguous"
			| undefined;
		/** Repos the (mocked) /installation/repositories enumeration returns. */
		installationRepos?: Array<{ owner: string; name: string }>;
	} = {},
): { router: ReturnType<typeof createAppInstallRoutes>; captured: RouterCapture } {
	const exchangeReturns =
		opts.exchangeReturns === undefined ? "fake-user-token" : opts.exchangeReturns;
	const authedLogin = opts.authedLogin ?? "installer-user";

	// Resolve the installations map: explicit `installations`, else the
	// `ownedInstallationIds` shorthand (personal installs owned by authedLogin).
	const installations: Record<number, MockAccount> | null =
		opts.installations !== undefined
			? opts.installations
			: Object.fromEntries(
					(opts.ownedInstallationIds ?? []).map((id) => [
						id,
						{ login: authedLogin, type: "User" as const },
					]),
				);

	const captured: RouterCapture = {
		exchangeCalls: 0,
		enqueuedFeedIds: [],
		repoFetchTokens: [],
	};

	// Derive the recovery sole-installation outcome: explicit opt, else inferred
	// from the installations map (sole → that install, >1 → ambiguous, 0 → null).
	const soleInstallation: typeof opts.soleInstallation = (() => {
		if (opts.soleInstallation !== undefined || "soleInstallation" in opts) {
			return opts.soleInstallation;
		}
		if (installations === null) return undefined;
		const entries = Object.entries(installations);
		if (entries.length === 0) return null;
		if (entries.length > 1) return "ambiguous";
		const [id, account] = entries[0];
		return { installationId: Number(id), account };
	})();

	const deps: AppInstallRouterDeps = {
		installationStore: createPostgresAppInstallationStore(),
		resolveInstallOrgId: async () => installOrgId,
		getPublicGatewayUrl: () =>
			opts.publicGatewayUrl === undefined
				? PUBLIC_GATEWAY_URL
				: opts.publicGatewayUrl,
		exchangeInstallOAuthCode: async (p) => {
			captured.exchangeCalls += 1;
			captured.exchangeRedirectUri = p.redirectUri;
			return exchangeReturns;
		},
		fetchInstallationAccount: async (_token, installationId) => {
			if (installations === null) return undefined; // HTTP failure
			const acct = installations[installationId];
			return acct ? acct : null; // null = not in the user's set
		},
		fetchAuthedUserLogin: async () => authedLogin,
		fetchOrgMembershipRole: async (_token, org) => {
			if (opts.orgRoles === null) return undefined; // HTTP failure
			return opts.orgRoles?.[org] ?? { state: "none", role: "none" };
		},
		fetchSoleAccessibleInstallation: async () => soleInstallation,
		fetchInstallationRepositories: async (token) => {
			captured.repoFetchTokens.push(token);
			return opts.installationRepos ?? [];
		},
		enqueueSyncRun: async (feedId) => {
			captured.enqueuedFeedIds.push(feedId);
			return feedId; // stand-in run id
		},
	};
	return { router: createAppInstallRoutes(deps), captured };
}

async function connectionCount(organizationId: string): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
		SELECT count(*)::int AS n FROM connections
		WHERE organization_id = ${organizationId}
			AND connector_key = ${CONNECTOR_KEY}
			AND deleted_at IS NULL
	`) as unknown as Array<{ n: number }>;
	return rows[0].n;
}

async function installCount(organizationId: string): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
		SELECT count(*)::int AS n FROM app_installations
		WHERE organization_id = ${organizationId}
			AND provider_app_id = ${PROVIDER_APP_ID}
	`) as unknown as Array<{ n: number }>;
	return rows[0].n;
}

/** Issue feeds on the org's github connections (the auto-provisioned shape). */
async function issueFeeds(
	organizationId: string,
): Promise<Array<{ id: number; repo_owner: string; repo_name: string; next_run_at: Date | null }>> {
	const sql = getDb();
	const rows = (await sql`
		SELECT f.id, f.config ->> 'repo_owner' AS repo_owner,
			f.config ->> 'repo_name' AS repo_name, f.next_run_at
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		WHERE c.organization_id = ${organizationId}
			AND c.connector_key = ${CONNECTOR_KEY}
			AND f.feed_key = 'issues'
			AND f.deleted_at IS NULL
		ORDER BY f.id
	`) as unknown as Array<{
		id: number;
		repo_owner: string;
		repo_name: string;
		next_run_at: Date | null;
	}>;
	return rows;
}

const ENV_KEYS = [
	"GITHUB_APP_ID",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_CLIENT_SECRET",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
const ORIGINAL_ENV_PK = process.env.GITHUB_APP_PRIVATE_KEY;

async function cleanTables(): Promise<void> {
	const sql = getTestDb();
	// runs → feeds → connections ordering to satisfy FKs.
	await sql`DELETE FROM runs WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM feeds WHERE connection_id IN (
		SELECT id FROM connections WHERE connector_key = ${CONNECTOR_KEY}
	)`;
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
	await sql`DELETE FROM oauth_states WHERE scope = 'github:app_install:state'`;
}

/**
 * Register a spy GitHub mint provider so the auto-provision step (which mints the
 * install's own token to enumerate repos) never reaches api.github.com. The
 * router's injected `fetchInstallationRepositories` returns the test's repo list,
 * so the token's value is irrelevant — only that minting succeeds.
 */
function installSpyMintProvider(): void {
	__resetInstallationTokenRegistryForTests();
	getInstallationTokenRegistry().register({
		provider: "github",
		async mintToken(install) {
			return {
				token: `spy-token-${install.id}`,
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			};
		},
	});
}

beforeAll(async () => {
	await initWorkspaceProvider();
});

beforeEach(async () => {
	process.env.GITHUB_APP_ID = PROVIDER_APP_ID;
	process.env.GITHUB_APP_SLUG = APP_SLUG;
	// App OAuth creds present by default so ownership verification can run; the
	// "unset" test deletes them explicitly.
	process.env.GITHUB_APP_CLIENT_ID = "Iv-test-app-client-id";
	process.env.GITHUB_APP_CLIENT_SECRET = "test-app-client-secret";
	// App private key so the spy/registry path is well-formed (value irrelevant —
	// the spy provider never signs, and repo enumeration is injected).
	process.env.GITHUB_APP_PRIVATE_KEY =
		ORIGINAL_ENV_PK ?? "-----BEGIN PRIVATE KEY-----\\nspy\\n-----END PRIVATE KEY-----";
	installSpyMintProvider();
	await cleanTables();
});

afterEach(async () => {
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	if (ORIGINAL_ENV_PK === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
	else process.env.GITHUB_APP_PRIVATE_KEY = ORIGINAL_ENV_PK;
	__resetInstallationTokenRegistryForTests();
	await cleanTables();
});

describe("GitHub App install callback — signed-state CSRF guard", () => {
	it("rejects a callback with NO state and writes no install/connection row", async () => {
		const org = await createTestOrganization({ name: "Victim Org NoState" });
		await seedGithubConnector(org.id);
		// The attacker's ambient session resolves to the victim org — proving the
		// reject is driven by the missing state, not org resolution.
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request(
				"http://gw.test/github/app/install/callback?installation_id=7001&setup_action=install",
			),
		);

		expect(res.status).toBe(400);
		// CRITICAL: zero mutation.
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("rejects a callback with an INVALID/forged state and writes nothing", async () => {
		const org = await createTestOrganization({ name: "Victim Org BadState" });
		await seedGithubConnector(org.id);
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request(
				"http://gw.test/github/app/install/callback?installation_id=7002&setup_action=install&state=forged-not-in-db",
			),
		);

		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("rejects a callback with a MISSING setup_action → 400, zero mutation", async () => {
		const org = await createTestOrganization({ name: "Org NoSetupAction" });
		await seedGithubConnector(org.id);
		// A valid state exists, but setup_action is absent — must 400 before any
		// state validation or mutation (not be treated like install/update).
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, { ownedInstallationIds: [7011] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7011&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("rejects a callback with a GARBAGE setup_action → 400, zero mutation", async () => {
		const org = await createTestOrganization({ name: "Org GarbageSetupAction" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, { ownedInstallationIds: [7012] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7012&setup_action=delete-everything&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("FIXATION: completing session org ≠ state org → 403 org_mismatch, zero mutation, nonce NOT consumed", async () => {
		// Confused-deputy: attacker (stateOrg) mints the link and sends it to a
		// victim, whose browser/session resolves to a DIFFERENT (ambient) org. Even
		// though the ownership check would pass (victim owns the installation), the
		// completing session's org must match the state's org or we reject — else the
		// victim's installation would land in the attacker's org. (This previously
		// asserted SUCCESS, codifying the vulnerability; flipped to assert the fix.)
		const stateOrg = await createTestOrganization({ name: "Attacker Initiator Org" });
		const ambientOrg = await createTestOrganization({ name: "Victim Session Org" });
		await seedGithubConnector(stateOrg.id);
		await seedGithubConnector(ambientOrg.id);

		const stateStore = createGithubInstallStateStore();
		const state = await stateStore.create({ organizationId: stateOrg.id });

		// resolveInstallOrgId resolves to the ambient (victim-session) org, NOT the
		// state's org → mismatch.
		const { router } = buildRouter(ambientOrg.id, { ownedInstallationIds: [7003] });
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7003&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(403);
		// Zero mutation in BOTH orgs.
		expect(await installCount(stateOrg.id)).toBe(0);
		expect(await connectionCount(stateOrg.id)).toBe(0);
		expect(await installCount(ambientOrg.id)).toBe(0);
		expect(await connectionCount(ambientOrg.id)).toBe(0);
		// The org check ran on a PEEK — the still-valid nonce was NOT burned, so the
		// legitimate org can still complete it.
		const stillThere = await stateStore.peek(state);
		expect(stillThere?.organizationId).toBe(stateOrg.id);
	});

	it("happy path: completing session org === state org → 200, binds to that org", async () => {
		const org = await createTestOrganization({ name: "Same Session Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});

		// resolveInstallOrgId === the state's org (the admin completes in the same
		// session they started in).
		const { router } = buildRouter(org.id, { ownedInstallationIds: [7003] });
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7003&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
		// The legit flow DID consume the nonce (single-use).
		const consumed = await createGithubInstallStateStore().peek(state);
		expect(consumed).toBeNull();
	});

	it("redirect_uri passed to the OAuth exchange is the public registered callback URL", async () => {
		const org = await createTestOrganization({ name: "Redirect URI Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router, captured } = buildRouter(org.id, {
			ownedInstallationIds: [7050],
		});

		const res = await router.fetch(
			new Request(
				// The request URL is the INTERNAL pod URL (http, pod host) — the
				// redirect_uri must NOT be derived from it.
				`http://internal-pod-host:8080/github/app/install/callback?installation_id=7050&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(200);
		expect(captured.exchangeCalls).toBe(1);
		// Exactly the App's registered public Callback URL — not the pod URL.
		expect(captured.exchangeRedirectUri).toBe(
			`${PUBLIC_GATEWAY_URL}/github/app/install/callback`,
		);
	});

	it("treats a consumed state as single-use: a replay is rejected with no extra row", async () => {
		const org = await createTestOrganization({ name: "Replay Org" });
		await seedGithubConnector(org.id);
		const stateStore = createGithubInstallStateStore();
		const state = await stateStore.create({ organizationId: org.id });
		const { router } = buildRouter(org.id, { ownedInstallationIds: [7004] });

		const first = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7004&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(first.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);

		// Replay the SAME state — it was consumed, so this is rejected.
		const replay = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7004&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(replay.status).toBe(400);
		// Still exactly one install + one connection — no duplicate from the replay.
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
	});

	it("the start route redirects to GitHub with a signed state bound to the org", async () => {
		const org = await createTestOrganization({ name: "Start Org" });
		await seedGithubConnector(org.id);
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request("http://gw.test/github/app/install"),
		);
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		expect(location).toContain(`https://github.com/apps/${APP_SLUG}/installations/new`);
		const minted = new URL(location).searchParams.get("state");
		expect(minted).toBeTruthy();

		// The minted state resolves to the org server-side (Postgres-backed nonce).
		const peeked = await createGithubInstallStateStore().peek(minted as string);
		expect(peeked?.organizationId).toBe(org.id);
	});
});

describe("GitHub App install callback — installation ownership guard", () => {
	it("ATTACKER: valid state + code, but installation_id NOT in /user/installations → 403, zero mutation", async () => {
		// Attacker has their own valid state (their own org A) and a code that
		// exchanges fine — but supplies a VICTIM's installation_id that the
		// attacker's GitHub account does not administer.
		const attackerOrg = await createTestOrganization({ name: "Attacker Org" });
		await seedGithubConnector(attackerOrg.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: attackerOrg.id,
		});
		// /user/installations returns only the attacker's OWN installs (e.g. 555),
		// NOT the victim id 8888 they're trying to steal.
		const { router } = buildRouter(attackerOrg.id, { ownedInstallationIds: [555] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=8888&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(403);
		// CRITICAL: no install/connection written for the foreign installation_id.
		expect(await installCount(attackerOrg.id)).toBe(0);
		expect(await connectionCount(attackerOrg.id)).toBe(0);
	});

	it("LEGIT: valid state + code + installation_id IS owned → 200, binds install + connection", async () => {
		const org = await createTestOrganization({ name: "Legit Owner Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, { ownedInstallationIds: [4242, 999] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=4242&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
		// The bound install carries the owned installation id (mint path reads this).
		const sql = getDb();
		const rows = (await sql`
			SELECT external_tenant_id FROM app_installations
			WHERE organization_id = ${org.id} AND provider_app_id = ${PROVIDER_APP_ID}
			LIMIT 1
		`) as unknown as Array<{ external_tenant_id: string }>;
		expect(rows[0].external_tenant_id).toBe("4242");
	});

	it("MISSING code → 400, zero mutation (ownership cannot be verified without it)", async () => {
		const org = await createTestOrganization({ name: "NoCode Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		// Even though the (mocked) ownership set WOULD contain the id, the absence
		// of `code` must reject before any exchange/lookup.
		const { router } = buildRouter(org.id, { ownedInstallationIds: [7777] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7777&setup_action=install&state=${state}`,
			),
		);

		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("GITHUB_APP_CLIENT_ID/SECRET unset → 503, zero mutation (fail safe)", async () => {
		delete process.env.GITHUB_APP_CLIENT_ID;
		delete process.env.GITHUB_APP_CLIENT_SECRET;
		const org = await createTestOrganization({ name: "NoOAuthCreds Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, { ownedInstallationIds: [6001] });

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=6001&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);

		expect(res.status).toBe(503);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("a failed OAuth code exchange → 403, zero mutation", async () => {
		const org = await createTestOrganization({ name: "BadCode Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		// Exchange returns null (bad_verification_code) → cannot prove identity.
		const { router } = buildRouter(org.id, {
			ownedInstallationIds: [5005],
			exchangeReturns: null,
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=5005&setup_action=install&state=${state}&code=stale-or-forged-code`,
			),
		);

		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});
});

describe("GitHub App install callback — account-ownership (admin vs member)", () => {
	// Helper: drive a callback for an org-account installation with a given
	// membership role for the authed user.
	async function runOrgInstall(opts: {
		installationId: number;
		orgLogin: string;
		role: { state: string; role: string } | null; // null → membership HTTP fail
	}) {
		const org = await createTestOrganization({ name: "Org Install Tenant" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, {
			installations: {
				[opts.installationId]: { login: opts.orgLogin, type: "Organization" },
			},
			orgRoles:
				opts.role === null ? null : { [opts.orgLogin]: opts.role },
		});
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=${opts.installationId}&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		return { org, res };
	}

	it("ORG install + user role 'admin' (active) → 200, binds", async () => {
		const { org, res } = await runOrgInstall({
			installationId: 3001,
			orgLogin: "acme-org",
			role: { state: "active", role: "admin" },
		});
		expect(res.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
	});

	it("ORG install + user role 'member' (active) → 403, zero mutation (the blocker case)", async () => {
		// A non-admin member can SEE the org's installation via /user/installations
		// but MUST NOT be able to bind it. This is the membership-≠-admin hole.
		const { org, res } = await runOrgInstall({
			installationId: 3002,
			orgLogin: "victim-org",
			role: { state: "active", role: "member" },
		});
		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("ORG install + membership state not active (pending admin) → 403, zero mutation", async () => {
		const { org, res } = await runOrgInstall({
			installationId: 3003,
			orgLogin: "pending-org",
			role: { state: "pending", role: "admin" },
		});
		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("ORG install + membership lookup fails → 403, zero mutation (cannot verify)", async () => {
		const { org, res } = await runOrgInstall({
			installationId: 3004,
			orgLogin: "unreachable-org",
			role: null,
		});
		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("USER (personal) install + authedLogin === account.login → 200, binds", async () => {
		const org = await createTestOrganization({ name: "Personal Owner Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router } = buildRouter(org.id, {
			authedLogin: "Octocat",
			installations: {
				4100: { login: "octocat", type: "User" }, // case-insensitive match
			},
		});
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=4100&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
	});

	it("USER install + authedLogin !== account.login → 403, zero mutation", async () => {
		const org = await createTestOrganization({ name: "Wrong Personal Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		// The user can SEE this personal install (collaborator) but does not OWN it.
		const { router } = buildRouter(org.id, {
			authedLogin: "attacker",
			installations: {
				4200: { login: "victim", type: "User" },
			},
		});
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=4200&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});
});

describe("GitHub App install callback — connection creation is race-safe", () => {
	it("two parallel callbacks for the same install create exactly one connection", async () => {
		const org = await createTestOrganization({ name: "Concurrency Org" });
		await seedGithubConnector(org.id);
		const installationId = 5150;

		// Two independent routers (two pods), each with its own valid single-use
		// state, racing the SAME installation. The advisory-lock-wrapped
		// find-or-create must converge to one connection.
		const stateA = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const stateB = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router: routerA } = buildRouter(org.id, {
			ownedInstallationIds: [installationId],
		});
		const { router: routerB } = buildRouter(org.id, {
			ownedInstallationIds: [installationId],
		});

		const [resA, resB] = await Promise.all([
			routerA.fetch(
				new Request(
					`http://gw.test/github/app/install/callback?installation_id=${installationId}&setup_action=install&state=${stateA}&code=valid-oauth-code`,
				),
			),
			routerB.fetch(
				new Request(
					`http://gw.test/github/app/install/callback?installation_id=${installationId}&setup_action=install&state=${stateB}&code=valid-oauth-code`,
				),
			),
		]);

		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);
		// Exactly one connection and one active install despite the race.
		expect(await connectionCount(org.id)).toBe(1);
		expect(await installCount(org.id)).toBe(1);
	});
});

describe("GitHub App install callback — auto-provision feeds", () => {
	it("creates one issues feed per repo (due now) and enqueues a backfill for each", async () => {
		const org = await createTestOrganization({ name: "AutoProvision Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router, captured } = buildRouter(org.id, {
			ownedInstallationIds: [6200],
			installationRepos: [
				{ owner: "acme", name: "api" },
				{ owner: "acme", name: "web" },
			],
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=6200&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(200);
		expect(await connectionCount(org.id)).toBe(1);

		// One issues feed per accessible repo, each active + due now (next_run_at set).
		const feeds = await issueFeeds(org.id);
		expect(feeds).toHaveLength(2);
		expect(feeds.map((f) => `${f.repo_owner}/${f.repo_name}`).sort()).toEqual([
			"acme/api",
			"acme/web",
		]);
		for (const f of feeds) {
			expect(f.next_run_at).not.toBeNull();
		}

		// A backfill sync run was enqueued for each new feed.
		expect(captured.enqueuedFeedIds.sort()).toEqual(
			feeds.map((f) => f.id).sort(),
		);
		// Repo enumeration used the install's OWN minted token (spy provider).
		expect(captured.repoFetchTokens.length).toBe(1);
		expect(captured.repoFetchTokens[0]).toMatch(/^spy-token-/);
	});

	it("is idempotent: re-bind reuses feeds and enqueues no duplicate backfill", async () => {
		const org = await createTestOrganization({ name: "AutoProvision Reidem Org" });
		await seedGithubConnector(org.id);

		const first = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const r1 = buildRouter(org.id, {
			ownedInstallationIds: [6300],
			installationRepos: [{ owner: "acme", name: "api" }],
		});
		const res1 = await r1.router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=6300&setup_action=install&state=${first}&code=valid-oauth-code`,
			),
		);
		expect(res1.status).toBe(200);
		expect(await issueFeeds(org.id)).toHaveLength(1);
		expect(r1.captured.enqueuedFeedIds).toHaveLength(1);

		// Second bind (same org+installation+repo) — fresh single-use state.
		const second = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const r2 = buildRouter(org.id, {
			ownedInstallationIds: [6300],
			installationRepos: [{ owner: "acme", name: "api" }],
		});
		const res2 = await r2.router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=6300&setup_action=install&state=${second}&code=valid-oauth-code`,
			),
		);
		expect(res2.status).toBe(200);

		// Still exactly one feed + one connection — no duplicate.
		expect(await issueFeeds(org.id)).toHaveLength(1);
		expect(await connectionCount(org.id)).toBe(1);
		// No backfill enqueued the second time (feed already existed).
		expect(r2.captured.enqueuedFeedIds).toHaveLength(0);
	});

	it("a successful bind with no accessible repos still succeeds (no feeds, no error)", async () => {
		const org = await createTestOrganization({ name: "AutoProvision Empty Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
		});
		const { router, captured } = buildRouter(org.id, {
			ownedInstallationIds: [6400],
			installationRepos: [],
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=6400&setup_action=install&state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(200);
		expect(await connectionCount(org.id)).toBe(1);
		expect(await issueFeeds(org.id)).toHaveLength(0);
		expect(captured.enqueuedFeedIds).toHaveLength(0);
	});

	it("CONCURRENCY: two parallel auto-provisions for the same (connection,repo) create exactly ONE feed (DB-enforced)", async () => {
		const org = await createTestOrganization({ name: "AutoProvision Race Org" });
		await seedGithubConnector(org.id);
		// Seed an active install + a connection bound to it — the shape auto-provision
		// operates on (mirrors what the callback produces).
		const store = createPostgresAppInstallationStore();
		const install = await store.upsert({
			organizationId: org.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "6900",
			status: "active",
			metadata: { appIdKey: "GITHUB_APP_ID", privateKeyKey: "GITHUB_APP_PRIVATE_KEY" },
		});
		const sql = getDb();
		const connRows = (await sql`
			INSERT INTO connections (organization_id, connector_key, slug, display_name, status, config)
			VALUES (${org.id}, ${CONNECTOR_KEY}, 'race-conn', 'Race Conn', 'active',
				${sql.json({ installation_ref: install.id })})
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const connectionId = Number(connRows[0].id);

		// Two concurrent provisions for the SAME repo, simulating a double-click /
		// two-tab race that completes AFTER the link advisory lock has released.
		// Both call createSyncRun for whatever feed they create.
		const provision = () =>
			autoProvisionGithubIssueFeeds({
				organizationId: org.id,
				connectionId,
				installId: install.id,
				store,
				fetchInstallationRepositories: async () => [
					{ owner: "acme", name: "api" },
				],
				enqueueSyncRun: async (feedId) => feedId,
			});

		const [a, b] = await Promise.all([provision(), provision()]);

		// DB-enforced: exactly ONE active issues feed for (connection, repo) despite
		// the race. The partial unique index serialized the two INSERTs.
		const feeds = await issueFeeds(org.id);
		expect(feeds).toHaveLength(1);
		// Exactly one of the two callers reports having CREATED the feed; the other
		// reuses it (createdFeeds 0). Both still resolve the same feed id.
		const totalCreated = a.createdFeeds + b.createdFeeds;
		expect(totalCreated).toBe(1);
		expect(a.feedIds).toEqual([feeds[0].id]);
		expect(b.feedIds).toEqual([feeds[0].id]);
		// Only the winner enqueued a backfill (no double-backfill).
		const totalEnqueued =
			a.enqueuedRunIds.length + b.enqueuedRunIds.length;
		expect(totalEnqueued).toBe(1);
	});
});

describe("GitHub App install callback — re-bind recovery (user-auth flow)", () => {
	it("start route routes through GitHub user-auth (recovery) when an install row already exists", async () => {
		const org = await createTestOrganization({ name: "Recovery Start Org" });
		await seedGithubConnector(org.id);
		// Pre-existing install row for this org+App → start route must use recovery.
		await createPostgresAppInstallationStore().upsert({
			organizationId: org.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "6500",
			status: "active",
		});
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request("http://gw.test/github/app/install"),
		);
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		// Recovery → user-authorization endpoint (NOT the installations/new page).
		expect(location).toContain("https://github.com/login/oauth/authorize");
		expect(location).toContain("client_id=");
		const minted = new URL(location).searchParams.get("state");
		const peeked = await createGithubInstallStateStore().peek(minted as string);
		expect(peeked?.organizationId).toBe(org.id);
		expect(peeked?.recovery).toBe(true);
	});

	it("explicit ?recovery=1 routes through user-auth even with no install row", async () => {
		const org = await createTestOrganization({ name: "Recovery Explicit Org" });
		await seedGithubConnector(org.id);
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request("http://gw.test/github/app/install?recovery=1"),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location") ?? "").toContain(
			"https://github.com/login/oauth/authorize",
		);
	});

	it("fresh org (no install row, no recovery flag) still routes to the install page", async () => {
		const org = await createTestOrganization({ name: "Fresh Install Org" });
		await seedGithubConnector(org.id);
		const { router } = buildRouter(org.id);

		const res = await router.fetch(
			new Request("http://gw.test/github/app/install"),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location") ?? "").toContain(
			`https://github.com/apps/${APP_SLUG}/installations/new`,
		);
	});

	it("recovery callback (no installation_id, no setup_action) derives the id and binds + provisions", async () => {
		const org = await createTestOrganization({ name: "Recovery Callback Org" });
		await seedGithubConnector(org.id);
		// A recovery-flagged state (as the start route would mint).
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
			recovery: true,
		});
		// The user administers exactly one installation (6600) → derived.
		const { router, captured } = buildRouter(org.id, {
			soleInstallation: {
				installationId: 6600,
				account: { login: "installer-user", type: "User" },
			},
			// fetchInstallationAccount must also confirm ownership of the derived id.
			installations: { 6600: { login: "installer-user", type: "User" } },
			installationRepos: [{ owner: "installer-user", name: "playground" }],
		});

		const res = await router.fetch(
			// No installation_id, no setup_action — the recovery shape.
			new Request(
				`http://gw.test/github/app/install/callback?state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(200);
		// Bound the DERIVED installation id (6600).
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);
		const sql = getDb();
		const rows = (await sql`
			SELECT external_tenant_id FROM app_installations
			WHERE organization_id = ${org.id} AND provider_app_id = ${PROVIDER_APP_ID}
			LIMIT 1
		`) as unknown as Array<{ external_tenant_id: string }>;
		expect(rows[0].external_tenant_id).toBe("6600");
		// Auto-provision still ran on the recovered bind.
		const feeds = await issueFeeds(org.id);
		expect(feeds).toHaveLength(1);
		expect(captured.enqueuedFeedIds).toHaveLength(1);
	});

	it("recovery callback with ambiguous installations → 400, zero mutation", async () => {
		const org = await createTestOrganization({ name: "Recovery Ambiguous Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
			recovery: true,
		});
		const { router } = buildRouter(org.id, {
			soleInstallation: "ambiguous",
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("recovery callback STILL enforces session-org === state-org (anti-fixation)", async () => {
		const stateOrg = await createTestOrganization({ name: "Recovery Attacker Org" });
		const ambientOrg = await createTestOrganization({ name: "Recovery Victim Org" });
		await seedGithubConnector(stateOrg.id);
		await seedGithubConnector(ambientOrg.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: stateOrg.id,
			recovery: true,
		});
		// Completing session resolves to the AMBIENT org, not the state's org.
		const { router } = buildRouter(ambientOrg.id, {
			soleInstallation: {
				installationId: 6700,
				account: { login: "installer-user", type: "User" },
			},
			installations: { 6700: { login: "installer-user", type: "User" } },
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(403);
		expect(await installCount(stateOrg.id)).toBe(0);
		expect(await installCount(ambientOrg.id)).toBe(0);
		// Nonce not burned (peek-based mismatch) — the legit org can still recover.
		const stillThere = await createGithubInstallStateStore().peek(state);
		expect(stillThere?.organizationId).toBe(stateOrg.id);
	});

	it("recovery callback STILL enforces ownership (org member, not admin → 403)", async () => {
		const org = await createTestOrganization({ name: "Recovery Member Org" });
		await seedGithubConnector(org.id);
		const state = await createGithubInstallStateStore().create({
			organizationId: org.id,
			recovery: true,
		});
		// Derived installation is an ORG account; the user is only a member.
		const { router } = buildRouter(org.id, {
			soleInstallation: {
				installationId: 6800,
				account: { login: "victim-org", type: "Organization" },
			},
			installations: { 6800: { login: "victim-org", type: "Organization" } },
			orgRoles: { "victim-org": { state: "active", role: "member" } },
		});

		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?state=${state}&code=valid-oauth-code`,
			),
		);
		expect(res.status).toBe(403);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});
});
