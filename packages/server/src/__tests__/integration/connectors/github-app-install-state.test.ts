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
	createAppInstallRoutes,
} from "../../../gateway/routes/public/app-install";
import { createGithubInstallStateStore } from "../../../gateway/auth/oauth/state-store";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
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

/** Build the install router; `resolveInstallOrgId` is fixed for the start route. */
function buildRouter(installOrgId: string | null) {
	const deps: AppInstallRouterDeps = {
		installationStore: createPostgresAppInstallationStore(),
		resolveInstallOrgId: async () => installOrgId,
	};
	return createAppInstallRoutes(deps);
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

const ORIGINAL_APP_ID = process.env.GITHUB_APP_ID;
const ORIGINAL_APP_SLUG = process.env.GITHUB_APP_SLUG;

beforeAll(async () => {
	await initWorkspaceProvider();
});

beforeEach(async () => {
	process.env.GITHUB_APP_ID = PROVIDER_APP_ID;
	process.env.GITHUB_APP_SLUG = APP_SLUG;
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
	await sql`DELETE FROM oauth_states WHERE scope = 'github:app_install:state'`;
});

afterEach(async () => {
	if (ORIGINAL_APP_ID === undefined) delete process.env.GITHUB_APP_ID;
	else process.env.GITHUB_APP_ID = ORIGINAL_APP_ID;
	if (ORIGINAL_APP_SLUG === undefined) delete process.env.GITHUB_APP_SLUG;
	else process.env.GITHUB_APP_SLUG = ORIGINAL_APP_SLUG;
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
	await sql`DELETE FROM oauth_states WHERE scope = 'github:app_install:state'`;
});

describe("GitHub App install callback — signed-state CSRF guard", () => {
	it("rejects a callback with NO state and writes no install/connection row", async () => {
		const org = await createTestOrganization({ name: "Victim Org NoState" });
		await seedGithubConnector(org.id);
		// The attacker's ambient session resolves to the victim org — proving the
		// reject is driven by the missing state, not org resolution.
		const router = buildRouter(org.id);

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
		const router = buildRouter(org.id);

		const res = await router.fetch(
			new Request(
				"http://gw.test/github/app/install/callback?installation_id=7002&setup_action=install&state=forged-not-in-db",
			),
		);

		expect(res.status).toBe(400);
		expect(await installCount(org.id)).toBe(0);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("accepts a callback carrying a valid signed state and binds to the STATE's org", async () => {
		const stateOrg = await createTestOrganization({ name: "Initiator Org" });
		const ambientOrg = await createTestOrganization({ name: "Ambient Other Org" });
		await seedGithubConnector(stateOrg.id);
		await seedGithubConnector(ambientOrg.id);

		// Mint a state bound to stateOrg (as GET /github/app/install would).
		const stateStore = createGithubInstallStateStore();
		const state = await stateStore.create({ organizationId: stateOrg.id });

		// The callback session resolves to a DIFFERENT (ambient) org — the install
		// must STILL land in the state's org, never the ambient one.
		const router = buildRouter(ambientOrg.id);
		const res = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7003&setup_action=install&state=${state}`,
			),
		);

		expect(res.status).toBe(200);
		// Install + connection landed in the STATE's org.
		expect(await installCount(stateOrg.id)).toBe(1);
		expect(await connectionCount(stateOrg.id)).toBe(1);
		// Nothing landed in the ambient org.
		expect(await installCount(ambientOrg.id)).toBe(0);
		expect(await connectionCount(ambientOrg.id)).toBe(0);
	});

	it("treats a consumed state as single-use: a replay is rejected with no extra row", async () => {
		const org = await createTestOrganization({ name: "Replay Org" });
		await seedGithubConnector(org.id);
		const stateStore = createGithubInstallStateStore();
		const state = await stateStore.create({ organizationId: org.id });
		const router = buildRouter(org.id);

		const first = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7004&setup_action=install&state=${state}`,
			),
		);
		expect(first.status).toBe(200);
		expect(await installCount(org.id)).toBe(1);
		expect(await connectionCount(org.id)).toBe(1);

		// Replay the SAME state — it was consumed, so this is rejected.
		const replay = await router.fetch(
			new Request(
				`http://gw.test/github/app/install/callback?installation_id=7004&setup_action=install&state=${state}`,
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
		const router = buildRouter(org.id);

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
