/**
 * App-installation credential resolution — tenancy + connector-shape guards.
 *
 * `resolveExecutionAuth` (via `resolveAppInstallationCredential`) loads the
 * `app_installations` row named by a connection's `config.installation_ref` and
 * mints a tenant-scoped token gateway-side. The security contract proven here:
 *
 *   1. SECURITY REGRESSION (cross-tenant leak): a connection in org A whose
 *      `config.installation_ref` points at an install OWNED BY org B resolves to
 *      NULL credentials and the token provider's `mintToken` is NEVER called.
 *      Without the org guard, org A would receive org B's minted token.
 *   2. Same-org happy path still mints (the guard doesn't break the legit path).
 *   3. Provider / providerInstance mismatch (same org, wrong connector shape) →
 *      NULL credentials, mint NOT called.
 *
 * The token provider is a SPY registered into the per-pod registry, so "mint not
 * called" is asserted directly rather than inferred. No `vi.mock` — the suite
 * runs `isolate:false`, where mocking shared singletons is unreliable; instead
 * we swap the registry's real provider for a spy via the test-only reset seam.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type InstallationTokenProvider,
	type MintedInstallationToken,
} from "../../../gateway/installation/installation-token-provider";
import {
	__resetInstallationTokenRegistryForTests,
	getInstallationTokenRegistry,
} from "../../../gateway/installation/registry";
import type { AppInstallationRow } from "../../../lobu/stores/app-installation-store";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { getDb } from "../../../db/client";
import { resolveExecutionAuth } from "../../../utils/execution-context";
import { initWorkspaceProvider } from "../../../workspace";
import { getTestDb } from "../../setup/test-db";
import {
	createTestConnectorDefinition,
	createTestConnection,
	createTestOrganization,
} from "../../setup/test-fixtures";

const CONNECTOR_KEY = "demo.appinstall";
const PROVIDER = "github";
const PROVIDER_INSTANCE = "cloud";

/** Counts `mintToken` calls so a test can assert it was (or was NOT) invoked. */
class SpyInstallationTokenProvider implements InstallationTokenProvider {
	readonly provider: string;
	mintCalls: AppInstallationRow[] = [];

	constructor(provider: string) {
		this.provider = provider;
	}

	async mintToken(install: AppInstallationRow): Promise<MintedInstallationToken> {
		this.mintCalls.push(install);
		return {
			token: `spy-token-for-install-${install.id}`,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		};
	}
}

let spy: SpyInstallationTokenProvider;

/** A `guardrail-trip` audit row written by the tenancy guard (subset we assert). */
interface TenancyTripEventRow {
	semantic_type: string;
	origin_type: string | null;
	metadata: Record<string, unknown>;
}

/**
 * The tenancy audit write is fire-and-forget (best-effort, never blocks
 * resolution), so the row may land just after `resolveExecutionAuth` returns.
 * Poll briefly for the guardrail-trip row scoped to this org + connection.
 */
async function waitForTenancyTripEvent(
	sql: ReturnType<typeof getTestDb>,
	organizationId: string,
	connectionId: number,
): Promise<TenancyTripEventRow | null> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const rows = (await sql`
			SELECT semantic_type, origin_type, metadata
			FROM events
			WHERE organization_id = ${organizationId}
				AND semantic_type = 'guardrail-trip'
				AND origin_type = 'guardrail-app-installation'
				AND (metadata ->> 'connection_id') = ${String(connectionId)}
			ORDER BY id DESC
			LIMIT 1
		`) as unknown as TenancyTripEventRow[];
		if (rows.length > 0) return rows[0];
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return null;
}

/**
 * Create a per-org connector definition declaring an `app_installation` auth
 * method, plus a connection in that org. `installationRef` is what we write into
 * the connection's `config.installation_ref` (it may point at ANOTHER org's
 * install — that's the attack we're guarding against).
 */
async function seedAppInstallConnection(opts: {
	organizationId: string;
	installationRef: number;
	provider?: string;
	/** `null` = the method omits providerInstance entirely (must default to 'cloud'). */
	providerInstance?: string | null;
}): Promise<{ connectionId: number }> {
	const method: Record<string, unknown> = {
		type: "app_installation",
		provider: opts.provider ?? PROVIDER,
		appIdKey: "DEMO_APP_ID",
		privateKeyKey: "DEMO_APP_PRIVATE_KEY",
	};
	if (opts.providerInstance !== null) {
		method.providerInstance = opts.providerInstance ?? PROVIDER_INSTANCE;
	}
	await createTestConnectorDefinition({
		key: CONNECTOR_KEY,
		name: "Demo App Install",
		organization_id: opts.organizationId,
		auth_schema: { methods: [method] },
	});

	const conn = await createTestConnection({
		organization_id: opts.organizationId,
		connector_key: CONNECTOR_KEY,
		config: { installation_ref: opts.installationRef },
		createDefaultFeed: false,
	});

	return { connectionId: conn.id };
}

/** Insert an ACTIVE install owned by `organizationId` and return its row. */
async function seedInstall(opts: {
	organizationId: string;
	provider?: string;
	providerInstance?: string;
	externalTenantId: string;
}): Promise<AppInstallationRow> {
	const store = createPostgresAppInstallationStore();
	return store.upsert({
		organizationId: opts.organizationId,
		provider: opts.provider ?? PROVIDER,
		providerInstance: opts.providerInstance ?? PROVIDER_INSTANCE,
		providerAppId: "demo-app",
		externalTenantId: opts.externalTenantId,
		status: "active",
	});
}

beforeEach(async () => {
	await initWorkspaceProvider();
	// Swap the real (GitHub) provider for a spy so we can assert mint was/wasn't
	// called. The reset seam drops the per-pod singleton; we rebuild it with ONLY
	// the spy registered.
	__resetInstallationTokenRegistryForTests();
	spy = new SpyInstallationTokenProvider(PROVIDER);
	getInstallationTokenRegistry().register(spy);
});

afterEach(async () => {
	// Don't leak fixtures across the shared DB; this suite owns one connector key
	// and the app_installations / connections it inserts.
	const sql = getTestDb();
	await sql`DELETE FROM connections WHERE connector_key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM connector_definitions WHERE key = ${CONNECTOR_KEY}`;
	await sql`DELETE FROM app_installations WHERE provider_app_id = 'demo-app'`;
});

afterAll(() => {
	// Restore the real provider wiring for any later suite in the shared process.
	__resetInstallationTokenRegistryForTests();
});

describe("app-installation credential — tenancy + shape guards", () => {
	it("SECURITY: a cross-org installation_ref resolves to NULL and NEVER mints", async () => {
		const orgA = await createTestOrganization({ name: "Attacker Org A" });
		const orgB = await createTestOrganization({ name: "Victim Org B" });

		// Victim org B owns the install.
		const victimInstall = await seedInstall({
			organizationId: orgB.id,
			externalTenantId: "victim-tenant",
		});

		// Attacker connection in org A points its installation_ref at org B's id.
		const { connectionId } = await seedAppInstallConnection({
			organizationId: orgA.id,
			installationRef: victimInstall.id,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: orgA.id,
			connectionId,
			credentialDb: getDb(),
		});

		// No credential leaked to the attacker org...
		expect(resolved.credentials).toBeNull();
		// ...and crucially the token provider was NEVER asked to mint.
		expect(spy.mintCalls).toHaveLength(0);
	});

	it("same-org happy path still mints a tenant-scoped token", async () => {
		const org = await createTestOrganization({ name: "Owner Org" });
		const install = await seedInstall({
			organizationId: org.id,
			externalTenantId: "owner-tenant",
		});
		const { connectionId } = await seedAppInstallConnection({
			organizationId: org.id,
			installationRef: install.id,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: org.id,
			connectionId,
			credentialDb: getDb(),
		});

		expect(resolved.credentials).not.toBeNull();
		expect(resolved.credentials?.provider).toBe(PROVIDER);
		expect(resolved.credentials?.accessToken).toBe(
			`spy-token-for-install-${install.id}`,
		);
		expect(spy.mintCalls).toHaveLength(1);
		expect(spy.mintCalls[0]?.id).toBe(install.id);
	});

	it("provider mismatch (same org, wrong provider) resolves to NULL and never mints", async () => {
		const org = await createTestOrganization({ name: "Mismatch Provider Org" });
		// The install is a 'slack' install...
		const install = await seedInstall({
			organizationId: org.id,
			provider: "slack",
			providerInstance: PROVIDER_INSTANCE,
			externalTenantId: "slack-tenant",
		});
		// ...but the connector method declares 'github'.
		const { connectionId } = await seedAppInstallConnection({
			organizationId: org.id,
			installationRef: install.id,
			provider: PROVIDER,
			providerInstance: PROVIDER_INSTANCE,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: org.id,
			connectionId,
			credentialDb: getDb(),
		});

		expect(resolved.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);
	});

	it("providerInstance mismatch (same org+provider, wrong instance) resolves to NULL and never mints", async () => {
		const org = await createTestOrganization({ name: "Mismatch Instance Org" });
		// Install on a GHES host instance...
		const install = await seedInstall({
			organizationId: org.id,
			provider: PROVIDER,
			providerInstance: "ghes.example.com",
			externalTenantId: "ghes-tenant",
		});
		// ...but the connector method pins 'cloud'.
		const { connectionId } = await seedAppInstallConnection({
			organizationId: org.id,
			installationRef: install.id,
			provider: PROVIDER,
			providerInstance: "cloud",
		});

		const resolved = await resolveExecutionAuth({
			organizationId: org.id,
			connectionId,
			credentialDb: getDb(),
		});

		expect(resolved.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);
	});

	it("AUDIT: a cross-tenant rejection emits a guardrail-trip event (security signal)", async () => {
		const orgA = await createTestOrganization({ name: "Audit Attacker Org" });
		const orgB = await createTestOrganization({ name: "Audit Victim Org" });

		const victimInstall = await seedInstall({
			organizationId: orgB.id,
			externalTenantId: "audit-victim-tenant",
		});
		const { connectionId } = await seedAppInstallConnection({
			organizationId: orgA.id,
			installationRef: victimInstall.id,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: orgA.id,
			connectionId,
			credentialDb: getDb(),
		});
		expect(resolved.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);

		// The audit write is best-effort/fire-and-forget — poll for the row.
		const sql = getTestDb();
		const event = await waitForTenancyTripEvent(sql, orgA.id, connectionId);
		expect(event).not.toBeNull();
		expect(event?.semantic_type).toBe("guardrail-trip");
		expect(event?.metadata?.guardrail).toBe("app-installation-tenancy");
		expect(event?.metadata?.reason).toBe("cross_tenant_org");
		expect(String(event?.metadata?.install_id)).toBe(String(victimInstall.id));
		expect(event?.metadata?.install_org).toBe(orgB.id);
		// The audit row is left in place — `events` is append-only and the row is
		// scoped to a throwaway test org, so it can't leak into other suites' asserts.
	});

	it("AUDIT: a provider/instance mismatch emits a guardrail-trip event", async () => {
		const org = await createTestOrganization({ name: "Audit Mismatch Org" });
		// Install is 'slack'; the connector method declares 'github'.
		const install = await seedInstall({
			organizationId: org.id,
			provider: "slack",
			providerInstance: PROVIDER_INSTANCE,
			externalTenantId: "audit-slack-tenant",
		});
		const { connectionId } = await seedAppInstallConnection({
			organizationId: org.id,
			installationRef: install.id,
			provider: PROVIDER,
			providerInstance: PROVIDER_INSTANCE,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: org.id,
			connectionId,
			credentialDb: getDb(),
		});
		expect(resolved.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);

		const sql = getTestDb();
		const event = await waitForTenancyTripEvent(sql, org.id, connectionId);
		expect(event).not.toBeNull();
		expect(event?.metadata?.reason).toBe("provider_instance_mismatch");
		expect(event?.metadata?.install_provider).toBe("slack");
		expect(event?.metadata?.method_provider).toBe("github");
	});

	it("SECURITY: after a cross-org TRANSFER the losing org's suspended install NEVER mints", async () => {
		const orgA = await createTestOrganization({ name: "Losing Org A" });
		const orgB = await createTestOrganization({ name: "Winning Org B" });
		const store = createPostgresAppInstallationStore();

		// Org A installs first (active) for tenant T.
		const aInstall = await store.upsert({
			organizationId: orgA.id,
			provider: PROVIDER,
			providerInstance: PROVIDER_INSTANCE,
			providerAppId: "demo-app",
			externalTenantId: "transfer-tenant",
			status: "active",
		});
		// Org A's connection points at A's install row.
		const { connectionId } = await seedAppInstallConnection({
			organizationId: orgA.id,
			installationRef: aInstall.id,
		});

		// Sanity: while A's install is active, A mints fine.
		const before = await resolveExecutionAuth({
			organizationId: orgA.id,
			connectionId,
			credentialDb: getDb(),
		});
		expect(before.credentials).not.toBeNull();
		expect(spy.mintCalls).toHaveLength(1);

		// Org B re-installs the SAME tenant → transfer: A's row is demoted to
		// 'suspended', B gets a new active row. A's connection still points at A's
		// now-suspended row.
		const bInstall = await store.upsert({
			organizationId: orgB.id,
			provider: PROVIDER,
			providerInstance: PROVIDER_INSTANCE,
			providerAppId: "demo-app",
			externalTenantId: "transfer-tenant",
			status: "active",
		});
		expect(bInstall.id).not.toBe(aInstall.id);
		const aAfter = await store.getById(aInstall.id);
		expect(aAfter?.status).toBe("suspended");

		// Now the losing org A resolves its connection → the install is suspended →
		// NULL credentials and the provider is NEVER asked to mint again.
		spy.mintCalls = [];
		const after = await resolveExecutionAuth({
			organizationId: orgA.id,
			connectionId,
			credentialDb: getDb(),
		});
		expect(after.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);
	});

	it("method that omits providerInstance defaults to 'cloud' and rejects a non-cloud install", async () => {
		const org = await createTestOrganization({ name: "Omit Instance Org" });
		// Install lives on a self-hosted (non-cloud) instance...
		const install = await seedInstall({
			organizationId: org.id,
			provider: PROVIDER,
			providerInstance: "ghes.example.com",
			externalTenantId: "ghes-omit-tenant",
		});
		// ...and the connector method does NOT pin an instance. Omitted must mean
		// 'cloud' (NOT wildcard), so this non-cloud install is rejected, no mint.
		const { connectionId } = await seedAppInstallConnection({
			organizationId: org.id,
			installationRef: install.id,
			provider: PROVIDER,
			providerInstance: null,
		});

		const resolved = await resolveExecutionAuth({
			organizationId: org.id,
			connectionId,
			credentialDb: getDb(),
		});

		expect(resolved.credentials).toBeNull();
		expect(spy.mintCalls).toHaveLength(0);
	});
});
