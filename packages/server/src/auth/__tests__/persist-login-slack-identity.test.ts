/**
 * Unit coverage for `persistLoginSlackIdentity`.
 *
 * On Slack sign-in we stamp the user's team-scoped `slack_user_id` (`T…:U…`)
 * onto their `$member` entity, sourced `auth:signup`. Resolution is id_token
 * PRIMARY (decode the stored OIDC id_token — no network) with a userinfo-fetch
 * FALLBACK. These cases pin: the id_token path (and that it makes NO fetch),
 * a clean fallback write, idempotency, the missing-team guard (never write a
 * bare id), malformed-id_token → fallback, and the non-Slack no-op.
 *
 * The network reads (userinfo fetch + provider config) are injected stubs; the
 * DB write path is REAL against the embedded test database — the `isolate:false`
 * vitest run makes `vi.mock` of shared singletons unreliable, so dependency
 * injection is the durable seam.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../__tests__/setup/test-fixtures";
import { resolveTenantMember } from "../../identity/auth-hook";
import type { PersistLoginSlackIdentityDeps } from "../subject-identities";
import {
	persistLoginSlackIdentity,
	provisionMemberAndCoreIdentities,
} from "../subject-identities";

const TEAM = "T1";
const USER = "U1";

async function seedMember(): Promise<{
	orgId: string;
	userId: string;
	memberEntityId: number;
}> {
	const org = await createTestOrganization({
		name: "Acme",
		visibility: "private",
	});
	const user = await createTestUser({
		name: "Alice",
		email: "alice@acme.test",
	});
	await addUserToOrganization(user.id, org.id, "owner");
	const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
		userId: user.id,
		email: "alice@acme.test",
		name: "Alice",
	});
	return { orgId: org.id, userId: user.id, memberEntityId };
}

/** Build an (unsigned-but-well-formed) JWT carrying the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
	const b64 = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

/** Deps that resolve the real tenant member but stub the two network reads. */
function depsWith(
	raw: Record<string, unknown> | null,
): PersistLoginSlackIdentityDeps {
	return {
		resolveTenantMember,
		getEnabledLoginProviderConfigs: async () => [
			{
				connectorKey: "slack",
				provider: "slack",
				loginScopes: [],
				clientIdKey: "SLACK_CLIENT_ID",
				clientSecretKey: "SLACK_CLIENT_SECRET",
				userinfoUrl: "https://slack.test/openid/connect/userInfo",
			},
		],
		fetchUserInfoWithRaw: async () => ({ raw, normalized: null }),
	};
}

/**
 * Deps that record whether the network fallback was reached. `raw` is what the
 * fetch returns when it IS called (the fallback path).
 */
function trackingDeps(raw: Record<string, unknown> | null): {
	deps: PersistLoginSlackIdentityDeps;
	calls: { fetched: boolean; configs: boolean };
} {
	const calls = { fetched: false, configs: false };
	return {
		calls,
		deps: {
			resolveTenantMember,
			getEnabledLoginProviderConfigs: async () => {
				calls.configs = true;
				return [];
			},
			fetchUserInfoWithRaw: async () => {
				calls.fetched = true;
				return { raw, normalized: null };
			},
		},
	};
}

async function slackIdentityCount(
	orgId: string,
	identifier: string,
): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n
    FROM entity_identities
    WHERE organization_id = ${orgId}
      AND namespace = 'slack_user_id'
      AND identifier = ${identifier}
      AND source_connector = 'auth:signup'
      AND deleted_at IS NULL
  `;
	return Number(rows[0]?.n ?? 0);
}

describe("persistLoginSlackIdentity", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	afterEach(async () => {
		await cleanupTestDatabase();
	});

	it("PRIMARY: decodes the stored id_token and writes (slack_user_id) with NO network fetch", async () => {
		const { orgId, userId, memberEntityId } = await seedMember();
		const { deps, calls } = trackingDeps(null);

		await persistLoginSlackIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
				idToken: makeJwt({
					"https://slack.com/team_id": TEAM,
					"https://slack.com/user_id": USER,
					sub: USER,
				}),
			},
			deps,
		);

		// The id_token carried everything → neither the userinfo fetch nor the
		// provider-config lookup was reached.
		expect(calls.fetched).toBe(false);
		expect(calls.configs).toBe(false);

		const sql = getTestDb();
		const rows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = 'slack_user_id'
        AND identifier = ${`${TEAM}:${USER}`}
        AND source_connector = 'auth:signup'
        AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].entity_id)).toBe(memberEntityId);
	});

	it("FALLBACK: no id_token → fetches userinfo and writes the team-scoped slack_user_id", async () => {
		const { orgId, userId, memberEntityId } = await seedMember();

		await persistLoginSlackIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
			},
			depsWith({ "https://slack.com/team_id": TEAM }),
		);

		const sql = getTestDb();
		const rows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = 'slack_user_id'
        AND identifier = ${`${TEAM}:${USER}`}
        AND source_connector = 'auth:signup'
        AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].entity_id)).toBe(memberEntityId);
	});

	it("FALLBACK: a malformed id_token falls back to the userinfo fetch", async () => {
		const { orgId, userId } = await seedMember();
		const { deps, calls } = trackingDeps({ "https://slack.com/team_id": TEAM });

		await persistLoginSlackIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
				idToken: "not-a-jwt",
			},
			deps,
		);

		// Malformed token decoded to nothing → fell through to the fetch path.
		expect(calls.fetched).toBe(true);
		expect(await slackIdentityCount(orgId, `${TEAM}:${USER}`)).toBe(1);
	});

	it("is idempotent — a second call writes no duplicate", async () => {
		const { orgId, userId } = await seedMember();
		const deps = depsWith({ "https://slack.com/team_id": TEAM });
		const account = {
			providerId: "slack",
			userId,
			accessToken: "xoxp-token",
			accountId: USER,
		};

		await persistLoginSlackIdentity(account, deps);
		await persistLoginSlackIdentity(account, deps);

		expect(await slackIdentityCount(orgId, `${TEAM}:${USER}`)).toBe(1);
	});

	it("never writes a bare id when team_id is missing", async () => {
		const { orgId, userId } = await seedMember();

		await persistLoginSlackIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
			},
			// No team_id in the userinfo body → normalizeSlackUserId returns null.
			depsWith({ sub: USER }),
		);

		const sql = getTestDb();
		const rows = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'slack_user_id'
        AND deleted_at IS NULL
    `;
		expect(Number(rows[0].n)).toBe(0);
	});

	it("is a no-op for a non-Slack provider", async () => {
		const { orgId, userId } = await seedMember();
		let fetched = false;

		await persistLoginSlackIdentity(
			{
				providerId: "google",
				userId,
				accessToken: "ya29-token",
				accountId: USER,
			},
			{
				resolveTenantMember,
				getEnabledLoginProviderConfigs: async () => [],
				fetchUserInfoWithRaw: async () => {
					fetched = true;
					return {
						raw: { "https://slack.com/team_id": TEAM },
						normalized: null,
					};
				},
			},
		);

		expect(fetched).toBe(false);
		const sql = getTestDb();
		const rows = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'slack_user_id'
        AND deleted_at IS NULL
    `;
		expect(Number(rows[0].n)).toBe(0);
	});
});
