/**
 * manage_connections create/connect guard: a connector whose PRIMARY auth method
 * is `app_installation` (e.g. github) must NOT be created directly with no
 * `installation_ref`. The only legitimate creator is the App install callback
 * (`linkGithubAppInstallation`), which stamps `config.installation_ref`. A direct
 * create with no ref would be a dead, unbound connection — so we reject it and
 * point the user at the install flow.
 *
 * The guard is connector-agnostic (keys on the auth method type), so this seeds a
 * generic `app_installation`-primary connector rather than github specifically.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { manageAuthProfiles } from "../../../tools/admin/manage_auth_profiles";
import { manageConnections } from "../../../tools/admin/manage_connections";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV = {} as Env;
const CONNECTOR_KEY = "demo.appinstall.guard";
const PROVIDER_APP_ID = "demo-app-install-guard";
const OTHER_PROVIDER_APP_ID = "other-demo-app-install-guard";
const previousDemoAppId = process.env.DEMO_APP_ID;
const seededConnectorDefinitions: Array<{
	organizationId: string;
	connectorKey: string;
}> = [];

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
		baseUrl: "https://gateway.test/lobu",
	} as ToolContext;
}

/**
 * Seed a connector whose PRIMARY auth method is app_installation, with oauth +
 * env_keys fallbacks — mirroring github's real schema (app_installation, oauth,
 * env_keys). The fallbacks let the selection-aware guard be exercised: a create
 * that targets oauth (auth_profile_slug) or env (config DEMO_TOKEN) must pass.
 */
async function seedAppInstallConnector(
	organizationId: string,
	opts?: {
		provider: "github";
		installShape: "github-app";
		connectorKey?: string;
	},
): Promise<void> {
	const connectorKey = opts?.connectorKey ?? CONNECTOR_KEY;
	await createTestConnectorDefinition({
		key: connectorKey,
		name: "Demo App Install Guard",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "app_installation",
					provider: opts?.provider ?? "slack",
					providerInstance: "cloud",
					installShape: opts?.installShape ?? "oauth-code-exchange",
					appIdKey: "DEMO_APP_ID",
					privateKeyKey: "DEMO_APP_PRIVATE_KEY",
				},
				{
					type: "oauth",
					provider: "slack",
					requiredScopes: ["read:user"],
					clientIdKey: "DEMO_CLIENT_ID",
					clientSecretKey: "DEMO_CLIENT_SECRET",
					tokenUrl: "https://example.test/token",
				},
				{ type: "env_keys", fields: [{ key: "DEMO_TOKEN" }] },
			],
		},
		feeds_schema: { items: {} },
	});
	seededConnectorDefinitions.push({ organizationId, connectorKey });
}

/**
 * Create a REAL, resolvable auth profile for the seeded connector so the
 * selection-aware guard sees a slug that actually resolves (the guard resolves
 * the slug against auth_profiles — a bare asserted string no longer satisfies
 * it). Returns the slug the profile ended up with.
 */
async function createRealAuthProfile(
	ctx: ToolContext,
	opts: {
		profileKind: "env" | "oauth_app";
		slug: string;
		credentials: Record<string, string>;
	},
): Promise<string> {
	const res = await manageAuthProfiles(
		{
			action: "create_auth_profile",
			connector_key: CONNECTOR_KEY,
			profile_kind: opts.profileKind,
			display_name: opts.slug,
			slug: opts.slug,
			credentials: opts.credentials,
		},
		TEST_ENV,
		ctx,
	);
	if (!("auth_profile" in res)) {
		throw new Error(
			`Failed to seed ${opts.profileKind} auth profile: ${JSON.stringify(res)}`,
		);
	}
	return (res.auth_profile as { slug: string }).slug;
}

async function connectionCount(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const rows = (await sql`
		SELECT count(*)::int AS n FROM connections
		WHERE organization_id = ${organizationId}
			AND connector_key = ${CONNECTOR_KEY}
			AND deleted_at IS NULL
	`) as unknown as Array<{ n: number }>;
	return rows[0].n;
}

beforeAll(async () => {
	process.env.DEMO_APP_ID = PROVIDER_APP_ID;
	await initWorkspaceProvider();
});

afterAll(() => {
	if (previousDemoAppId === undefined) delete process.env.DEMO_APP_ID;
	else process.env.DEMO_APP_ID = previousDemoAppId;
});

afterEach(async () => {
	const sql = getTestDb();
	for (const { organizationId, connectorKey } of seededConnectorDefinitions) {
		await sql`
			DELETE FROM connections
			WHERE organization_id = ${organizationId}
				AND connector_key = ${connectorKey}
		`;
		await sql`
			DELETE FROM auth_profiles
			WHERE organization_id = ${organizationId}
				AND connector_key = ${connectorKey}
		`;
		await sql`
			DELETE FROM connector_definitions
			WHERE organization_id = ${organizationId}
				AND key = ${connectorKey}
		`;
	}
	seededConnectorDefinitions.length = 0;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${PROVIDER_APP_ID}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = ${OTHER_PROVIDER_APP_ID}`;
});

describe("manage_connections — app_installation create guard", () => {
	it("create with NO installation_ref returns an actionable install continuation, no row written", async () => {
		const org = await createTestOrganization({ name: "App Install Guard Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "should-not-exist",
				display_name: "Should Not Exist",
				device_worker_id: null,
			},
			TEST_ENV,
			ctx,
		);

		expect("error" in res).toBe(false);
		expect(res).toMatchObject({
			action: "create",
			status: "setup_required",
			setup_family: "app_installation",
			connector_key: CONNECTOR_KEY,
			provider: "slack",
			next_action: "install_app",
			install_url: "https://gateway.test/lobu/slack/install",
		});
		const setupUrl = new URL((res as { setup_url: string }).setup_url);
		expect(setupUrl.pathname).toContain("/connectors");
		expect(setupUrl.searchParams.get("install")).toBe(CONNECTOR_KEY);
		expect(res).not.toHaveProperty("resume_call");
		// Zero rows created.
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("connect with NO installation_ref is also rejected (same guard, connect path)", async () => {
		const org = await createTestOrganization({
			name: "App Install Connect Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				slug: "should-not-exist-connect",
			},
			TEST_ENV,
			ctx,
		);

		// connect returns the same non-terminal continuation as create.
		expect("error" in res).toBe(false);
		expect(res).toMatchObject({
			action: "connect",
			status: "setup_required",
			setup_family: "app_installation",
			next_action: "install_app",
			install_url: "https://gateway.test/lobu/slack/install",
		});
		const setupUrl = new URL((res as { setup_url: string }).setup_url);
		expect(setupUrl.searchParams.get("install")).toBe(CONNECTOR_KEY);
		expect(res).not.toHaveProperty("resume_call");
		// Generic oauth-code-exchange installs do not expose a callback correlation
		// id, so returning an "any active Slack connection" poll would be unsafe.
		expect(res).not.toHaveProperty("completion_check");
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("connect reports an active installation in another accessible workspace", async () => {
		const currentOrg = await createTestOrganization({
			name: "Current App Install Org",
		});
		const connectedOrg = await createTestOrganization({
			name: "Connected App Install Org",
		});
		const otherInstanceOrg = await createTestOrganization({
			name: "Other Provider Instance Org",
		});
		const otherAppOrg = await createTestOrganization({
			name: "Other Provider App Org",
		});
		const installOnlyOrg = await createTestOrganization({
			name: "Install Only Org",
		});
		// The caller is a plain member here, and the connection belongs to someone
		// else privately — the workspace must stay invisible to this listing.
		const memberOnlyOrg = await createTestOrganization({
			name: "Member Only Private Org",
		});
		const user = await createTestUser();
		const otherUser = await createTestUser();
		await addUserToOrganization(user.id, currentOrg.id, "owner");
		await addUserToOrganization(user.id, connectedOrg.id, "owner");
		await addUserToOrganization(user.id, otherInstanceOrg.id, "owner");
		await addUserToOrganization(user.id, otherAppOrg.id, "owner");
		await addUserToOrganization(user.id, installOnlyOrg.id, "owner");
		await addUserToOrganization(user.id, memberOnlyOrg.id, "member");
		await addUserToOrganization(otherUser.id, memberOnlyOrg.id, "owner");
		await seedAppInstallConnector(currentOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});
		await seedAppInstallConnector(connectedOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});
		await seedAppInstallConnector(otherInstanceOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});
		await seedAppInstallConnector(otherAppOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});
		await seedAppInstallConnector(installOnlyOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});
		await seedAppInstallConnector(memberOnlyOrg.id, {
			provider: "github",
			installShape: "github-app",
			connectorKey: "github",
		});

		const store = createPostgresAppInstallationStore();
		const install = await store.upsert({
			organizationId: connectedOrg.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "T-DEMO-CONNECTED-ELSEWHERE",
			status: "active",
		});
		const otherInstanceInstall = await store.upsert({
			organizationId: otherInstanceOrg.id,
			provider: "github",
			providerInstance: "github.example.test",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "T-DEMO-OTHER-INSTANCE",
			status: "active",
		});
		const otherAppInstall = await store.upsert({
			organizationId: otherAppOrg.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: OTHER_PROVIDER_APP_ID,
			externalTenantId: "T-DEMO-OTHER-APP",
			status: "active",
		});
		const installOnly = await store.upsert({
			organizationId: installOnlyOrg.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "T-DEMO-INSTALL-ONLY",
			status: "active",
		});
		const memberOnlyInstall = await store.upsert({
			organizationId: memberOnlyOrg.id,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: PROVIDER_APP_ID,
			externalTenantId: "T-DEMO-MEMBER-ONLY",
			status: "active",
		});
		const sql = getTestDb();
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, created_by
			) VALUES (
				${connectedOrg.id}, 'github', 'connected-elsewhere',
				'Connected Elsewhere', 'active',
				${sql.json({ installation_ref: install.id })}, ${user.id}
			)
		`;
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, created_by
			) VALUES (
				${otherAppOrg.id}, 'github', 'other-provider-app',
				'Other Provider App', 'active',
				${sql.json({ installation_ref: otherAppInstall.id })}, ${user.id}
			)
		`;
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, created_by
			) VALUES (
				${otherInstanceOrg.id}, 'github', 'other-instance',
				'Other Instance', 'active',
				${sql.json({ installation_ref: otherInstanceInstall.id })}, ${user.id}
			)
		`;
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, visibility,
				config, created_by
			) VALUES (
				${memberOnlyOrg.id}, 'github', 'member-only-private',
				'Member Only Private', 'active', 'private',
				${sql.json({ installation_ref: memberOnlyInstall.id })}, ${otherUser.id}
			)
		`;

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: "github",
			},
			TEST_ENV,
			ctxFor(currentOrg.id, user.id),
		);

		expect(res).toMatchObject({
			action: "connect",
			status: "connected_in_other_workspace",
			connector_key: "github",
			current_workspace: { id: currentOrg.id },
			accessible_workspaces: [
				{
					workspace: { id: connectedOrg.id },
					connection: { slug: "connected-elsewhere", status: "active" },
					switch_workspace: {
						next_action: "switch_workspace",
						organization_id: connectedOrg.id,
					},
				},
			],
		});
		// Only the workspace whose connection the caller can actually see is listed:
		// the member-only workspace's PRIVATE connection (owned by someone else)
		// must not leak its slug — nor an installation the caller could transfer.
		expect(
			(res as { accessible_workspaces: unknown[] }).accessible_workspaces,
		).toHaveLength(1);
		expect(JSON.stringify(res)).not.toContain("member-only-private");
		expect(JSON.stringify(res)).not.toContain("other-provider-app");
		expect(res).toHaveProperty(
			"transfer_installation_here.next_action",
			"transfer_installation_here",
		);
		const transferOptions = (
			res as {
				transfer_installation_here: {
					options: Array<{
						source_installation_id: number;
						transfer_url: string;
					}>;
				};
			}
		).transfer_installation_here.options;
		expect(transferOptions).toHaveLength(2);
		expect(
			transferOptions.some(
				(option) => option.source_installation_id === install.id,
			),
		).toBe(true);
		const installOnlyOption = transferOptions.find(
			(option) => option.source_installation_id === installOnly.id,
		);
		expect(installOnlyOption).toMatchObject({
			source_installation_id: installOnly.id,
		});
		expect(installOnlyOption?.transfer_url).toContain(
			`source_installation_id=${installOnly.id}`,
		);
		expect(res).not.toHaveProperty("accessible_workspaces.0.connection.config");
		// The install_url the caller is sent to still pins the attempt id, so the
		// poll affordance from the plain setup_required continuation survives.
		expect(res).toHaveProperty("setup_attempt_id");
		expect(res).toHaveProperty(
			"install_app_here.install_url",
			expect.stringContaining(
				`setup_attempt_id=${(res as { setup_attempt_id: string }).setup_attempt_id}`,
			),
		);
		expect(res).toHaveProperty("completion_check.call.sdk_method");
		const currentGithubRows = await sql`
			SELECT id FROM connections
			WHERE organization_id = ${currentOrg.id}
				AND connector_key = 'github'
				AND deleted_at IS NULL
		`;
		expect(currentGithubRows).toHaveLength(0);

		await sql`
			DELETE FROM connections
			WHERE organization_id = ${connectedOrg.id}
				AND config ->> 'installation_ref' = ${String(install.id)}
		`;
		const installOnlyResult = await manageConnections(
			{ action: "connect", connector_key: "github" },
			TEST_ENV,
			ctxFor(currentOrg.id, user.id),
		);
		expect(installOnlyResult).toMatchObject({
			status: "connected_in_other_workspace",
			accessible_workspaces: [],
		});
		expect(installOnlyResult).toHaveProperty(
			"instructions",
			expect.stringContaining(
				"GitHub App installation is active in another workspace you administer",
			),
		);

		const patResult = await manageConnections(
			{ action: "connect", connector_key: "github" },
			TEST_ENV,
			{ ...ctxFor(currentOrg.id, user.id), tokenType: "pat" },
		);
		expect(patResult).toMatchObject({
			action: "connect",
			status: "setup_required",
			next_action: "install_app",
		});
		expect(patResult).not.toHaveProperty("accessible_workspaces");

		const invalidGatewayUrlResult = await manageConnections(
			{ action: "connect", connector_key: "github" },
			TEST_ENV,
			{ ...ctxFor(currentOrg.id, user.id), baseUrl: "not-a-valid-url" },
		);
		expect(invalidGatewayUrlResult).toMatchObject({
			action: "connect",
			status: "setup_required",
			next_action: "install_app",
		});
	});

	it("create WITH installation_ref in config is allowed past the guard (the callback's shape)", async () => {
		// The install callback creates the connection with config.installation_ref
		// set. The guard must NOT block that shape — it should pass through (any
		// later failure is unrelated to this guard).
		const org = await createTestOrganization({ name: "App Install Bound Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bound-conn",
				display_name: "Bound Conn",
				device_worker_id: null,
				config: { installation_ref: 12345 },
			},
			TEST_ENV,
			ctx,
		);

		// The app-install guard did not intercept it. A later auth-selection
		// continuation is valid, but it must not send the caller back to install.
			expect(res).not.toHaveProperty("next_action", "install_app");
		if ("action" in res && res.action === "create" && "connection" in res) {
			expect(await connectionCount(org.id)).toBe(1);
		} else {
			expect(await connectionCount(org.id)).toBe(0);
		}
	});
});

describe("manage_connections — app_installation guard is SELECTION-AWARE (regression)", () => {
	/** Assert the create/connect was NOT rejected by the app-install guard. */
	function expectGuardSkipped(res: unknown): void {
		if (res && typeof res === "object" && "error" in res) {
			// A later failure (e.g. missing OAuth profile) is fine — it must just NOT
			// be the install-flow guidance the guard produces.
			expect(res).not.toHaveProperty("next_action", "install_app");
		}
		// No error at all is also a pass (guard skipped, create proceeded).
	}

	/** Assert the create/connect WAS rejected by the app-install guard. */
	function expectGuardRejected(res: unknown): void {
		expect(res && typeof res === "object" && "error" in res).toBe(false);
		expect(res).toMatchObject({
			status: "setup_required",
			setup_family: "app_installation",
			provider: "slack",
			next_action: "install_app",
		});
	}

	it("create WITH a RESOLVABLE auth_profile_slug (oauth intent) is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({
			name: "OAuth Profile Create Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		// A REAL env-backed profile the guard can resolve to.
		const slug = await createRealAuthProfile(ctx, {
			profileKind: "env",
			slug: "real-env-profile",
			credentials: { DEMO_TOKEN: "ghp_real_token" },
		});

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "oauth-create",
				display_name: "OAuth Create",
				device_worker_id: null,
				auth_profile_slug: slug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("connect WITH a RESOLVABLE auth_profile_slug (oauth intent) is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({
			name: "OAuth Profile Connect Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		const slug = await createRealAuthProfile(ctx, {
			profileKind: "env",
			slug: "real-env-profile-connect",
			credentials: { DEMO_TOKEN: "ghp_real_token" },
		});

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				slug: "oauth-connect",
				auth_profile_slug: slug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("create WITH a NON-EXISTENT auth_profile_slug + no installation_ref is REJECTED (bypass closed)", async () => {
		// The latent gap: the guard used to TRUST the asserted slug. A caller could
		// pass a bogus, non-resolvable slug to bypass the guard and create a dead,
		// unbound app_installation connection. The guard now RESOLVES the slug —
		// an unresolvable one is treated as no slug at all → rejected.
		const org = await createTestOrganization({ name: "Bogus Slug Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bogus-slug-create",
				display_name: "Bogus Slug Create",
				device_worker_id: null,
				// No such auth profile exists for this org/connector.
				auth_profile_slug: "does-not-exist-anywhere",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardRejected(res);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("connect WITH a NON-EXISTENT auth_profile_slug + no installation_ref is REJECTED (bypass closed)", async () => {
		const org = await createTestOrganization({
			name: "Bogus Slug Connect Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTOR_KEY,
				slug: "bogus-slug-connect",
				auth_profile_slug: "does-not-exist-anywhere",
			},
			TEST_ENV,
			ctx,
		);
		// connect path now surfaces the bypass-closed outcome as a setup_required
		// continuation (no `error` field), so it survives run_sdk. The bogus slug
		// still falls through to app_installation and is rejected/continued.
		expect(res && typeof res === "object" && "error" in res).toBe(false);
		expect(res).toMatchObject({
			action: "connect",
			status: "setup_required",
			setup_family: "app_installation",
			next_action: "install_app",
		});
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("create WITH a NON-EXISTENT app_auth_profile_slug + no installation_ref is REJECTED (bypass closed)", async () => {
		const org = await createTestOrganization({ name: "Bogus App Slug Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bogus-app-slug-create",
				display_name: "Bogus App Slug Create",
				device_worker_id: null,
				app_auth_profile_slug: "no-such-oauth-app",
			},
			TEST_ENV,
			ctx,
		);
		expectGuardRejected(res);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("create WITH auth_profile_slug pointing at an oauth_app (WRONG KIND) + no installation_ref is REJECTED", async () => {
		// auth_profile_slug must resolve to a CREDENTIAL profile (env / account /
		// browser / interactive). An oauth_app carries only the app's
		// client_id/secret — it does NOT provide the connection's auth, so pointing
		// auth_profile_slug at one is the wrong kind and must NOT satisfy the guard.
		const org = await createTestOrganization({
			name: "Wrong Kind Account Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		// Seed a REAL, resolvable oauth_app profile, then mis-target it.
		const appSlug = await createRealAuthProfile(ctx, {
			profileKind: "oauth_app",
			slug: "wrong-kind-app-profile",
			credentials: {
				DEMO_CLIENT_ID: "client-id",
				DEMO_CLIENT_SECRET: "client-secret",
			},
		});

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "wrong-kind-account-create",
				display_name: "Wrong Kind Account Create",
				device_worker_id: null,
				// Resolvable, but it's an oauth_app — wrong kind for auth_profile_slug.
				auth_profile_slug: appSlug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardRejected(res);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("create WITH app_auth_profile_slug pointing at a non-oauth_app profile (WRONG KIND) + no installation_ref is REJECTED", async () => {
		// app_auth_profile_slug must resolve to an oauth_app. Pointing it at a real
		// env (credential) profile is the wrong kind and must NOT satisfy the guard.
		const org = await createTestOrganization({ name: "Wrong Kind App Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		// Seed a REAL, resolvable env profile, then mis-target it as the app profile.
		const envSlug = await createRealAuthProfile(ctx, {
			profileKind: "env",
			slug: "wrong-kind-env-profile",
			credentials: { DEMO_TOKEN: "ghp_real_token" },
		});

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "wrong-kind-app-create",
				display_name: "Wrong Kind App Create",
				device_worker_id: null,
				// Resolvable, but it's an env profile — wrong kind for app_auth_profile_slug.
				app_auth_profile_slug: envSlug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardRejected(res);
		expect(await connectionCount(org.id)).toBe(0);
	});

	it("create WITH env/PAT creds in config is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "PAT Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "pat-create",
				display_name: "PAT Create",
				device_worker_id: null,
				// The connector's declared env field key — supplying it is env/PAT intent.
				config: { DEMO_TOKEN: "ghp_xxx_personal_access_token" },
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("create WITH a RESOLVABLE app_auth_profile_slug is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({
			name: "App Profile Create Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		// A REAL oauth_app profile (local client creds) the guard can resolve to.
		const appSlug = await createRealAuthProfile(ctx, {
			profileKind: "oauth_app",
			slug: "real-oauth-app",
			credentials: {
				DEMO_CLIENT_ID: "client-id",
				DEMO_CLIENT_SECRET: "client-secret",
			},
		});

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "appprofile-create",
				display_name: "App Profile Create",
				device_worker_id: null,
				app_auth_profile_slug: appSlug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("lobu-apply-style oauth create (RESOLVABLE auth_profile_slug, no installation_ref) is ALLOWED", async () => {
		// `lobu apply` of a declared github oauth connection sends auth_profile_slug
		// (createConnection in apply/client.ts). It must pass the guard (it did on
		// origin/main — the over-broad guard broke it) — provided the slug resolves.
		const org = await createTestOrganization({ name: "Apply OAuth Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);
		const accountSlug = await createRealAuthProfile(ctx, {
			profileKind: "env",
			slug: "gh-oauth",
			credentials: { DEMO_TOKEN: "ghp_real_token" },
		});
		const appSlug = await createRealAuthProfile(ctx, {
			profileKind: "oauth_app",
			slug: "gh-oauth-app",
			credentials: {
				DEMO_CLIENT_ID: "client-id",
				DEMO_CLIENT_SECRET: "client-secret",
			},
		});

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "apply-oauth-conn",
				display_name: "Apply OAuth Conn",
				device_worker_id: null,
				auth_profile_slug: accountSlug,
				app_auth_profile_slug: appSlug,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("create WITH a managedBy.org grant is ALLOWED past the guard", async () => {
		const org = await createTestOrganization({ name: "ManagedBy Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "managed-create",
				display_name: "Managed Create",
				device_worker_id: null,
				config: { managedBy: { org: org.id } },
			},
			TEST_ENV,
			ctx,
		);
		expectGuardSkipped(res);
	});

	it("STILL rejects: create with NO creds and NO installation_ref → install-flow guidance", async () => {
		// The core intent must remain: a bare create (no auth intent) falls through
		// to the app_installation primary and is rejected.
		const org = await createTestOrganization({ name: "Bare Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedAppInstallConnector(org.id);
		const ctx = ctxFor(org.id, user.id);

		const res = await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				slug: "bare-create",
				display_name: "Bare Create",
				device_worker_id: null,
			},
			TEST_ENV,
			ctx,
		);
		expectGuardRejected(res);
		expect(await connectionCount(org.id)).toBe(0);
	});
});
