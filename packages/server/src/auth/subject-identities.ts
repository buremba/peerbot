/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * Used by the signup hook to populate the identity graph so the gateway can
 * later route inbound messages back to the right user's personal org via a
 * single entity_identities lookup.
 */

import { normalizeSlackUserId } from "@lobu/connector-sdk";
import { fetchUserInfoWithRaw } from "../connect/oauth-providers";
import { getDb } from "../db/client";
import {
	type ResolvedTenantMember,
	resolveTenantMember,
} from "../identity/auth-hook";
import logger from "../utils/logger";
import {
	ensureMemberEntity,
	resolveMemberSchemaFields,
} from "../utils/member-entity";
import { getEnabledLoginProviderConfigs } from "./config";

const log = logger.child({ module: "auth-subject-identities" });

interface PersonalSubject {
	userId: string;
	email: string;
	name?: string | null;
	image?: string | null;
}

interface IdentityRow {
	namespace: string;
	identifier: string;
}

type Sql = ReturnType<typeof getDb>;

/**
 * Insert (or no-op on conflict) entity_identities rows pointing at the given
 * member entity. The unique index on (organization_id, namespace, identifier)
 * WHERE deleted_at IS NULL guards against duplicates.
 */
async function writeIdentities(
	sql: Sql,
	organizationId: string,
	memberEntityId: number,
	source: string,
	rows: IdentityRow[],
): Promise<void> {
	for (const row of rows) {
		await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES (
        ${organizationId}, ${memberEntityId}, ${row.namespace}, ${row.identifier}, ${source}
      )
      ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
      DO NOTHING
    `;
	}
}

async function findMemberEntityIdByEmail(
	sql: Sql,
	organizationId: string,
	email: string,
): Promise<number | null> {
	const { emailField } = await resolveMemberSchemaFields(organizationId);
	const rows = await sql.unsafe(
		`SELECT e.id
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE et.slug = '$member'
      AND e.organization_id = $1
      AND e.metadata->>$2 = $3
      AND e.deleted_at IS NULL
    LIMIT 1`,
		[organizationId, emailField, email],
	);
	if (rows.length === 0) return null;
	return Number(rows[0].id);
}

/**
 * Create a $member entity for the user in the given org and write the core
 * personal identifiers (auth_user_id, email). Idempotent — safe to call again.
 */
export async function provisionMemberAndCoreIdentities(
	organizationId: string,
	subject: PersonalSubject,
): Promise<{ memberEntityId: number }> {
	await ensureMemberEntity({
		organizationId,
		userId: subject.userId,
		name: subject.name?.trim() || subject.email.split("@")[0],
		email: subject.email,
		image: subject.image ?? undefined,
		role: "owner",
		status: "active",
	});

	const sql = getDb();
	const memberEntityId = await findMemberEntityIdByEmail(
		sql,
		organizationId,
		subject.email,
	);
	if (memberEntityId === null) {
		throw new Error(
			`Failed to locate $member entity for user ${subject.userId} in org ${organizationId} after ensureMemberEntity`,
		);
	}

	await writeIdentities(sql, organizationId, memberEntityId, "auth:signup", [
		{ namespace: "auth_user_id", identifier: subject.userId },
		{ namespace: "email", identifier: subject.email.toLowerCase() },
	]);

	return { memberEntityId };
}

/**
 * The slice of a BetterAuth social-login account this needs. Structurally
 * satisfied by the `accountSummary` the auth hooks already build.
 */
export interface LoginAccountForSlackIdentity {
	providerId: string;
	userId: string;
	accessToken?: string | null;
	/**
	 * The provider's external account id (the bare Slack `U…` sub), distinct
	 * from the BetterAuth row PK. Preferred over the userinfo body when present.
	 */
	accountId?: string | null;
	/**
	 * The OIDC id_token BetterAuth stored on the account row at the login code
	 * exchange. Slack's id_token payload carries both `https://slack.com/team_id`
	 * and `https://slack.com/user_id`, so when present we read them straight from
	 * it — no second HTTP round-trip / provider-config lookup needed.
	 */
	idToken?: string | null;
}

/**
 * Decode the claims (payload) of a JWT without verifying its signature. Safe
 * here because this is our own server-stored token from a TLS code exchange —
 * same trust level as the access token we already store and use. Mirrors
 * better-auth's own `decodeJwt`. Returns null on any malformation.
 */
function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
	const seg = jwt.split(".")[1];
	if (!seg) return null;
	try {
		return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return null;
	}
}

/**
 * Injected boundary so tests can stub the network reads (userinfo fetch +
 * provider config) while exercising the real DB write path. Defaults wire the
 * production implementations. This is the `isolate: false` vitest-safe seam:
 * the integration suite shares one module graph, so `vi.mock` of these shared
 * singletons is unreliable — dependency injection is the durable alternative.
 */
export interface PersistLoginSlackIdentityDeps {
	resolveTenantMember: (userId: string) => Promise<ResolvedTenantMember | null>;
	getEnabledLoginProviderConfigs: typeof getEnabledLoginProviderConfigs;
	fetchUserInfoWithRaw: typeof fetchUserInfoWithRaw;
}

const defaultPersistDeps: PersistLoginSlackIdentityDeps = {
	resolveTenantMember,
	getEnabledLoginProviderConfigs,
	fetchUserInfoWithRaw,
};

/**
 * On Slack sign-in, write the user's team-scoped `slack_user_id` (`T…:U…`) onto
 * their `$member` entity, sourced `auth:signup`. Idempotent — a duplicate is a
 * no-op via the `entity_identities` unique index.
 *
 * Effect: the ACL Slack channel-graph collapses the workspace member onto the
 * existing `$member` instead of forking a separate `person`, because both sides
 * now resolve on the same canonical `slack_user_id`.
 *
 * Fire-and-forget — failures log and never throw into the auth hook.
 */
export async function persistLoginSlackIdentity(
	account: LoginAccountForSlackIdentity,
	deps: PersistLoginSlackIdentityDeps = defaultPersistDeps,
): Promise<void> {
	try {
		if (account.providerId.trim().toLowerCase() !== "slack") return;
		if (!account.accessToken) return;

		const resolved = await deps.resolveTenantMember(account.userId);
		if (!resolved) {
			log.debug(
				{ userId: account.userId },
				"slack-identity: no tenant $member yet — skipping slack_user_id write",
			);
			return;
		}

		let teamId: string | null | undefined;
		let bareUser: string | null | undefined;
		let source: "id_token" | "userinfo-fallback" = "id_token";

		// PRIMARY: read team + user straight out of the stored id_token. No network.
		if (account.idToken) {
			const claims = decodeJwtClaims(account.idToken);
			if (claims) {
				teamId = claims["https://slack.com/team_id"] as
					| string
					| null
					| undefined;
				bareUser = (account.accountId ??
					claims["https://slack.com/user_id"] ??
					claims.sub) as string | null | undefined;
			}
		}

		// FALLBACK: no id_token (or it yielded no team_id) → the userinfo endpoint.
		// One extra HTTP round-trip + a provider-config DB read, kept behind the
		// injected deps seam so it stays testable.
		if (!teamId) {
			source = "userinfo-fallback";
			const cfgs = await deps.getEnabledLoginProviderConfigs(
				resolved.tenantOrganizationId,
			);
			const slackCfg = cfgs.find((c) => c.provider.toLowerCase() === "slack");
			const { raw } = await deps.fetchUserInfoWithRaw({
				provider: "slack",
				accessToken: account.accessToken,
				userinfoUrl: slackCfg?.userinfoUrl,
			});
			teamId = raw?.["https://slack.com/team_id"] as string | null | undefined;
			bareUser = (account.accountId ??
				raw?.["https://slack.com/user_id"] ??
				raw?.sub) as string | null | undefined;
		}

		// null = missing team id or malformed → NEVER write a bare, un-scoped id
		// (two workspaces can share a `U…`, so a bare id would bleed across orgs).
		const combined = normalizeSlackUserId(teamId, bareUser);
		if (!combined) {
			log.debug(
				{ userId: account.userId },
				"slack-identity: missing team_id or user id — skipping slack_user_id write",
			);
			return;
		}

		await writeIdentities(
			getDb(),
			resolved.tenantOrganizationId,
			resolved.memberEntityId,
			"auth:signup",
			[{ namespace: "slack_user_id", identifier: combined }],
		);
		log.debug(
			{
				userId: account.userId,
				organizationId: resolved.tenantOrganizationId,
				source,
			},
			"slack-identity: wrote slack_user_id onto $member",
		);
	} catch (err) {
		log.error(
			{ err, userId: account.userId, providerId: account.providerId },
			"slack-identity: failed to persist slack_user_id on login",
		);
	}
}
