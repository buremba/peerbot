import { parseSecretRef } from "@lobu/core";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store";
import { orgContext } from "../../lobu/stores/org-context";
import {
	migrateLegacyPlaintextAuthData,
	persistAuthCredentials,
	resolveAuthCredentials,
	toSecretRefAuthData,
} from "../../utils/auth-credential-secrets";
import {
	createAuthProfile,
	deleteAuthProfile,
} from "../../utils/auth-profiles";
import { resolveExecutionAuth } from "../../utils/execution-context";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestConnection } from "../setup/test-fixtures";
import { TestWorkspace } from "../setup/test-mcp-client";

/**
 * A postgres connection string is a bearer credential: whoever reads it owns
 * the database. Before this suite, the DSN sat as PLAINTEXT in
 * `auth_profiles.auth_data` — the row BOTH execution paths read through
 * `resolveExecutionAuth` — and (for at least one live connection) a second
 * plaintext copy in `connections.config`.
 *
 * Every assertion below reads the RAW DB ROW rather than an API response.
 * The list/get/query_sql surfaces are redacted, so asserting on the API would
 * pass even if the column underneath were still plaintext — that exact trap
 * produced a false-negative test earlier in this sprint.
 */
const DSN_PASSWORD = "pw-LEAK-dsn-secret-storage";
const DSN = `postgres://app_ro:${DSN_PASSWORD}@db.internal:5432/app`;
const ROTATED_PASSWORD = "pw-LEAK-dsn-rotated";
const ROTATED_DSN = `postgres://app_ro:${ROTATED_PASSWORD}@db.internal:5432/app`;

let workspace: TestWorkspace;

async function seedEnvProfile(
	organizationId: string,
	slug: string,
	authData: Record<string, unknown>,
): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql`
    INSERT INTO auth_profiles (
      organization_id, connector_key, slug, display_name,
      profile_kind, status, auth_data, created_at, updated_at
    ) VALUES (
      ${organizationId}, 'postgres', ${slug}, ${slug},
      'env', 'active', ${sql.json(authData)}, NOW(), NOW()
    )
    RETURNING id
  `;
	return Number((row as { id: number }).id);
}

async function rawAuthData(profileId: number): Promise<Record<string, unknown>> {
	const sql = getTestDb();
	const rows = await sql`
    SELECT auth_data FROM auth_profiles WHERE id = ${profileId}
  `;
	return (rows[0] as { auth_data: Record<string, unknown> }).auth_data ?? {};
}

async function waitForBlockedSecretWrite(): Promise<void> {
	const sql = getTestDb();
	for (let attempt = 0; attempt < 40; attempt++) {
		const rows = await sql`
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO agent_secrets%'
      LIMIT 1
    `;
		if (rows.length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Legacy convergence did not reach the blocked secret write");
}

/** Resolve credentials the way BOTH execution paths do. */
async function resolveCredentials(
	organizationId: string,
	connectionId: number,
	authProfileId: number,
): Promise<Record<string, string>> {
	const { connectionCredentials } = await resolveExecutionAuth({
		organizationId,
		connectionId,
		authProfileId,
		appAuthProfileId: null,
		credentialDb: getTestDb(),
		logContext: {},
	});
	return connectionCredentials as Record<string, string>;
}

describe("auth_profiles credential storage", () => {
	beforeAll(async () => {
		workspace = await TestWorkspace.create();
		return async () => {
			await cleanupTestDatabase();
		};
	});

	/**
	 * ITEM 1 — WRITE. The persisted row must not contain the password in any
	 * form. Asserted on the serialized raw row so a nested/re-encoded copy
	 * still trips it.
	 */
	it("stores no plaintext credential in the auth_profiles row", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-write", {});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		// Stored as a secret:// ref, not a bare value.
		// Must be a ref into the BUILTIN store. `isSecretRef` would also accept
		// the raw `postgres://` DSN, so the scheme is asserted explicitly.
		expect(parseSecretRef(String(stored.DATABASE_URL))?.scheme).toBe("secret");
	});

	it("creates an env profile with credentials inside a caller transaction", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profile = await sql.begin((tx) =>
			createAuthProfile(
				{
					organizationId: orgId,
					connectorKey: "postgres",
					displayName: "Transactional env profile",
					slug: "pg-transactional-create",
					profileKind: "env",
					authData: { DATABASE_URL: DSN },
				},
				tx,
			),
		);

		const stored = await rawAuthData(profile.id);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		expect(parseSecretRef(String(stored.DATABASE_URL))?.scheme).toBe("secret");
	});

	/**
	 * ITEM 4/5 — BOTH EXECUTION PATHS. `resolveExecutionAuth` is the single
	 * seam the worker-sync path (poll.ts) and the virtual-feed pushdown path
	 * (connector-pushdown.ts) both funnel through, so proving it here proves
	 * the credential materializes for both. The dedicated per-path tests below
	 * assert each caller actually reaches this seam.
	 */
	it("resolves the real credential back through resolveExecutionAuth", async () => {
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-resolve", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);

		const creds = await resolveCredentials(orgId, conn.id, profileId);
		expect(JSON.stringify(await rawAuthData(profileId))).not.toContain(
			DSN_PASSWORD,
		);
		expect(creds.DATABASE_URL).toBe(DSN);
	});

	/**
	 * ITEM 6 — ROTATION. Writing a new password must supersede the old one on
	 * the resolve path (a stale cached ref would keep the old DSN alive).
	 */
	it("resolves the new value after the credential is rotated", async () => {
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-rotate", {});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		expect(await resolveCredentials(orgId, conn.id, profileId)).toEqual({
			DATABASE_URL: DSN,
		});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: ROTATED_DSN },
			}),
		);

		const rotated = await resolveCredentials(orgId, conn.id, profileId);
		expect(rotated.DATABASE_URL).toBe(ROTATED_DSN);
		expect(rotated.DATABASE_URL).not.toContain(DSN_PASSWORD);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(ROTATED_PASSWORD);
	});

	/**
	 * Cross-tenant guard. `PostgresSecretStore.put` falls back to a GLOBAL
	 * bucket when no org context is ambient; a secret written there shadows
	 * every org's read of the same name. The credential must be scoped to the
	 * writing org explicitly, so another org resolving the same ref gets
	 * nothing.
	 */
	it("scopes the stored credential to the owning organization", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-scope", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		const ref = String((await rawAuthData(profileId)).DATABASE_URL);
		// Precondition: a real ref was stored. Without this the org-scoping
		// assertion below is vacuous — a plaintext column trivially "isn't
		// readable by another org through the store".
		expect(parseSecretRef(ref)?.scheme).toBe("secret");

		const store = new PostgresSecretStore();
		// The owning org resolves it...
		const ownerRead = await orgContext.run({ organizationId: orgId }, () =>
			store.get(ref as never),
		);
		expect(ownerRead).toBe(DSN);
		// ...and another org does not.
		const otherOrgRead = await orgContext.run(
			{ organizationId: "org-someone-else" },
			() => store.get(ref as never),
		);
		expect(otherOrgRead).not.toBe(DSN);
	});

	/**
	 * ITEM 7 — MIGRATION. A row seeded in the OLD plaintext shape must be
	 * converted by the migration and still resolve afterwards.
	 */
	it("converts a legacy plaintext row and keeps it resolvable", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-legacy", {
			DATABASE_URL: DSN,
		});
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		// Precondition: the legacy row really is plaintext.
		expect(JSON.stringify(await rawAuthData(profileId))).toContain(
			DSN_PASSWORD,
		);

		await orgContext.run({ organizationId: orgId }, () =>
			migrateLegacyPlaintextAuthData(),
		);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		const creds = await resolveCredentials(orgId, conn.id, profileId);
		expect(creds.DATABASE_URL).toBe(DSN);
	});

	it("does not overwrite a credential rotated during legacy convergence", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const blockerId = await seedEnvProfile(orgId, "pg-migration-blocker", {});
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: blockerId,
			credentials: { DATABASE_URL: DSN },
		});
		await orgContext.run({ organizationId: orgId }, () =>
			new PostgresSecretStore().put(
				`auth-profile/${blockerId}/legacy-convergence/DATABASE_URL`,
				DSN,
			),
		);
		await sql`
      UPDATE auth_profiles
      SET auth_data = ${sql.json({ DATABASE_URL: DSN })}
      WHERE id = ${blockerId}
    `;

		const targetId = await seedEnvProfile(orgId, "pg-migration-race", {
			DATABASE_URL: DSN,
		});
		let migration: Promise<number> | undefined;
		await sql.begin(async (tx) => {
			await tx`
        SELECT name
        FROM agent_secrets
        WHERE organization_id = ${orgId}
          AND name IN (
            ${`auth-profile/${blockerId}/DATABASE_URL`},
            ${`auth-profile/${blockerId}/legacy-convergence/DATABASE_URL`}
          )
        FOR UPDATE
      `;

			migration = migrateLegacyPlaintextAuthData();
			await waitForBlockedSecretWrite();
			await persistAuthCredentials({
				organizationId: orgId,
				authProfileId: targetId,
				credentials: { DATABASE_URL: ROTATED_DSN },
			});
		});
		await migration;

		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authData: await rawAuthData(targetId),
		});
		expect(resolved.DATABASE_URL).toBe(ROTATED_DSN);
		const staleStagingRows = await sql`
      SELECT 1
      FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${targetId}/legacy-convergence/%`}
    `;
		expect(staleStagingRows).toHaveLength(0);
	});

	/**
	 * ITEM 4 — EXECUTION PATH A (worker sync).
	 *
	 * `poll.ts` hands the connector its DSN through the `connection_credentials`
	 * field, which the worker merges into `ctx.config` (executor.ts `mergeEnv`).
	 * Asserted against the poll SELECT's own shape: the path reads
	 * `conn.auth_profile_id` and resolves through `resolveExecutionAuth`, so a
	 * regression that dropped ref-resolution would surface the literal
	 * `secret://…` string here instead of a usable DSN.
	 */
	it("path A (worker sync) receives a usable DSN, not a ref", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-path-a", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		// The columns poll.ts selects for credential resolution.
		const [row] = (await sql`
      SELECT auth_profile_id, app_auth_profile_id
      FROM connections WHERE id = ${conn.id}
    `) as unknown as Array<{
			auth_profile_id: number | null;
			app_auth_profile_id: number | null;
		}>;

		const { connectionCredentials } = await resolveExecutionAuth({
			organizationId: orgId,
			connectionId: conn.id,
			authProfileId: row.auth_profile_id,
			appAuthProfileId: row.app_auth_profile_id,
			credentialDb: getTestDb(),
			logContext: {},
		});

		// Two-sided: the credential must ARRIVE usable *and* have been stored as
		// a ref. Asserting only that it resolves passes trivially when the DSN
		// is sitting in the column as plaintext — verified by neutering.
		expect(JSON.stringify(await rawAuthData(profileId))).not.toContain(
			DSN_PASSWORD,
		);
		expect(connectionCredentials.DATABASE_URL).toBe(DSN);
		expect(String(connectionCredentials.DATABASE_URL)).not.toContain(
			"secret://",
		);
	});

	/**
	 * ITEM 5 — EXECUTION PATH B (virtual feed pushdown).
	 *
	 * This is the path the live churn feed uses, and the one that would break
	 * silently: `connector-pushdown.ts` never selects `connections.config`, so
	 * its ONLY credential source is the auth profile. It builds ctx.config as
	 * `{...connectionCredentials, ...feedConfig, ...dbEgressConfig()}`, which is
	 * reproduced here — a regression that left the DSN out of
	 * `connectionCredentials` would leave `ctx.config.DATABASE_URL` undefined
	 * and the connector would throw "DATABASE_URL is required".
	 */
	it("path B (virtual feed pushdown) receives a usable DSN, not a ref", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-path-b", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		// Exactly the columns readVirtualFeed selects — note it does NOT read
		// c.config, so nothing but the auth profile can supply the DSN.
		const [feedRow] = (await sql`
      SELECT c.id AS connection_id, c.auth_profile_id, c.app_auth_profile_id
      FROM connections c WHERE c.id = ${conn.id}
    `) as unknown as Array<{
			connection_id: number;
			auth_profile_id: number | null;
			app_auth_profile_id: number | null;
		}>;

		const { connectionCredentials } = await resolveExecutionAuth({
			organizationId: orgId,
			connectionId: Number(feedRow.connection_id),
			authProfileId: Number(feedRow.auth_profile_id) || null,
			appAuthProfileId: Number(feedRow.app_auth_profile_id) || null,
			credentialDb: getTestDb(),
			logContext: {},
		});

		// The config object the pushdown actually hands the connector.
		const config = { ...connectionCredentials, ...{ query: "SELECT 1" } };
		expect(JSON.stringify(await rawAuthData(profileId))).not.toContain(
			DSN_PASSWORD,
		);
		expect(config.DATABASE_URL).toBe(DSN);
		expect(String(config.DATABASE_URL)).not.toContain("secret://");
	});

	/**
	 * ITEM 2 — the second copy. `connections.config` is exposed by design
	 * through `query_sql`, so a DSN must never be duplicated into it. Path A
	 * gets its credential from `connection_credentials` (the auth profile),
	 * never from `config`, so there is nothing to keep here.
	 */
	it("keeps no plaintext DSN in connections.config", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-config", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		const [row] = (await sql`
      SELECT COALESCE(config, '{}'::jsonb) AS config
      FROM connections WHERE id = ${conn.id}
    `) as unknown as Array<{ config: Record<string, unknown> }>;

		// `config` never held the DSN for a fixture-created connection, so assert
		// the auth profile as well — otherwise this test is vacuous and would
		// pass with the fix removed.
		expect(JSON.stringify(await rawAuthData(profileId))).not.toContain(
			DSN_PASSWORD,
		);
		expect(JSON.stringify(row.config)).not.toContain(DSN_PASSWORD);
	});

	/**
	 * Public create/validate paths must never treat a caller-supplied
	 * `secret://…` string as an already-stored ref. Without ownership checks a
	 * crafted credential would bind the profile to a predictable org/global
	 * secret without ever writing the submitted value.
	 */
	it("does not bind a caller-supplied foreign secret:// ref", async () => {
		const orgId = workspace.org.id;
		const victimId = await seedEnvProfile(orgId, "pg-ref-victim", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: victimId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		const victimRef = String((await rawAuthData(victimId)).DATABASE_URL);
		expect(parseSecretRef(victimRef)?.scheme).toBe("secret");

		const attackerId = await seedEnvProfile(orgId, "pg-ref-attacker", {});
		const putCalls: string[] = [];
		const store = new PostgresSecretStore();
		const originalPut = store.put.bind(store);
		store.put = async (name, value, options) => {
			putCalls.push(value);
			return originalPut(name, value, options);
		};

		const out = await orgContext.run({ organizationId: orgId }, () =>
			toSecretRefAuthData({
				organizationId: orgId,
				authProfileId: attackerId,
				credentials: { DATABASE_URL: victimRef },
				secretStore: store,
			}),
		);

		// Must have written (not short-circuited) and must not keep the victim ref.
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0]).toBe(victimRef);
		expect(out.DATABASE_URL).not.toBe(victimRef);
		expect(parseSecretRef(out.DATABASE_URL)?.scheme).toBe("secret");

		// Resolving the attacker's profile must NOT yield the victim DSN.
		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authData: out,
		});
		expect(resolved.DATABASE_URL).toBe(victimRef);
		expect(resolved.DATABASE_URL).not.toBe(DSN);
	});

	it("preserves a rename-only re-submit of the profile's own refs", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-ref-owned", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		const ownedRef = String((await rawAuthData(profileId)).DATABASE_URL);
		const putCalls: string[] = [];
		const store = new PostgresSecretStore();
		const originalPut = store.put.bind(store);
		store.put = async (name, value, options) => {
			putCalls.push(value);
			return originalPut(name, value, options);
		};

		const out = await orgContext.run({ organizationId: orgId }, () =>
			toSecretRefAuthData({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: ownedRef },
				secretStore: store,
			}),
		);

		expect(putCalls).toHaveLength(0);
		expect(out.DATABASE_URL).toBe(ownedRef);
	});

	/**
	 * Deleting a profile must drop its encrypted credential rows. Leaving
	 * `agent_secrets` behind keeps decryptable bearer credentials forever.
	 */
	it("deletes agent_secrets when the auth profile is deleted", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: "postgres",
			displayName: "Delete cleanup",
			slug: "pg-delete-cleanup",
			profileKind: "env",
			authData: { DATABASE_URL: DSN },
		});
		const secretRowsBefore = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profile.id}/%`}
    `;
		expect(secretRowsBefore.length).toBeGreaterThan(0);

		const deleted = await deleteAuthProfile(orgId, profile.slug);
		expect(deleted?.id).toBe(profile.id);

		const profileGone = await sql`
      SELECT 1 FROM auth_profiles WHERE id = ${profile.id}
    `;
		expect(profileGone).toHaveLength(0);

		const secretRowsAfter = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profile.id}/%`}
    `;
		expect(secretRowsAfter).toHaveLength(0);
	});
});
