/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * Used by the signup hook to populate the identity graph so the gateway can
 * later route inbound messages back to the right user's personal org via a
 * single entity_identities lookup.
 */

import { normalizeSlackUserId, SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import { fetchUserInfoWithRaw } from "../connect/oauth-providers";
import { getDb } from "../db/client";
import {
	type ResolvedTenantMember,
	resolveMemberOrgsForUser,
} from "../identity/member-orgs";
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
	/**
	 * Role recorded on a NEWLY created `$member` (ignored when the entity already
	 * exists — ensureMemberEntity never rewrites the role of an existing member).
	 * Defaults to `owner` for the personal-org sign-up path; the backfill passes
	 * the member row's actual role so a drifted non-owner is not minted as owner.
	 */
	role?: string;
}

interface IdentityRow {
	namespace: string;
	identifier: string;
}

type Sql = ReturnType<typeof getDb>;

/**
 * Insert (or no-op on conflict) entity_identities rows pointing at the given
 * member entity. The unique index on (organization_id, namespace, identifier,
 * COALESCE(scope_key, ''))
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
      ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
      DO NOTHING
    `;
	}
}

/**
 * Point a workspace-scoped chat identity at the user's `$member`, taking it over
 * from a `person` entity when one already owns it.
 *
 * Why an UPDATE and not another INSERT: `entity_identities` has a live-unique
 * index on `(organization_id, namespace, identifier,
 * COALESCE(scope_key, ''))`, so the claim exists at most once —
 * auth-written identities are always org-scoped (NULL). `writeIdentities`'
 * `ON CONFLICT DO NOTHING` therefore SILENTLY LOSES
 * whenever the ACL sync minted a `person` for this workspace user before the
 * human ever signed in — which is the normal ordering, since channel sync runs
 * on a timer and sign-in is a one-off. The gate only ever resolves a `$member`
 * (channel-visibility.ts), so leaving the claim on the `person` hides every
 * enforced channel from its real owner.
 *
 * Re-pointing the claim is sufficient on its own: the ACL graph builder resolves
 * members by whoever owns the identity (`resolveMembers` is deliberately
 * type-agnostic) and reconciles `member_of` edges from that entity on the next
 * sync tick, so the edges follow the claim. Writing edges here by hand would be
 * undone by that same reconcile.
 *
 * SAFETY: only ever called with an identity proven by the provider's own OIDC
 * token for THIS user, and only for an org the user is already a better-auth
 * member of. It never grants org membership, and it never matches on a
 * user-editable field such as a Slack profile email — a workspace admin can set
 * those, which would let an attacker attach their `U…` to a victim's `$member`.
 *
 * The takeover is scoped to `person` entities. A claim already held by another
 * `$member` is a genuine identity conflict (two humans, one Slack id) and is
 * left alone — fail closed, never steal.
 */
async function adoptSlackIdentityOntoMember(
	sql: Sql,
	organizationId: string,
	memberEntityId: number,
	identifier: string,
): Promise<"created" | "adopted" | "already-owned" | "conflict"> {
	const inserted = await sql<{ id: number }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector
    ) VALUES (
      ${organizationId}, ${memberEntityId}, ${SLACK_IDENTITY.USER_ID}, ${identifier}, 'auth:signup'
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id
  `;
	if (inserted.length > 0) return "created";

	// Take over only from a `person`; a `$member` holder means two humans claim
	// one workspace id, which must not be silently reassigned.
	const adopted = await sql<{ id: number }>`
    UPDATE entity_identities ei
    SET entity_id = ${memberEntityId},
        source_connector = 'auth:signup',
        -- Keep a trail back to the person we took this from, matching the
        -- convention in entity-merge.ts (COALESCE so a re-run never overwrites
        -- the ORIGINAL owner with an intermediate one).
        merged_from_entity_id = COALESCE(ei.merged_from_entity_id, ei.entity_id),
        updated_at = current_timestamp
    FROM entities e
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${SLACK_IDENTITY.USER_ID}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.id = ei.entity_id
      AND e.organization_id = ei.organization_id
      AND et.slug = 'person'
    RETURNING ei.id
  `;
	if (adopted.length > 0) return "adopted";

	const mine = await sql<{ id: number }>`
    SELECT id FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${SLACK_IDENTITY.USER_ID}
      AND identifier = ${identifier}
      AND entity_id = ${memberEntityId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return mine.length > 0 ? "already-owned" : "conflict";
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
	const sql = getDb();
	const owners = await sql<{ email: string | null }>`
    SELECT email FROM "user" WHERE id = ${subject.userId} LIMIT 1
  `;
	if (
		owners[0]?.email?.trim().toLowerCase() !==
		subject.email.trim().toLowerCase()
	) {
		throw new Error(
			`Refusing to provision identities for user ${subject.userId}: user does not own the member email`,
		);
	}

	await ensureMemberEntity({
		organizationId,
		userId: subject.userId,
		name: subject.name?.trim() || subject.email.split("@")[0],
		email: subject.email,
		image: subject.image ?? undefined,
		role: subject.role ?? "owner",
		status: "active",
	});

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
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
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
	/**
	 * EVERY org where this user is a `$member`, not just their personal one — a
	 * Slack workspace identity is meaningful in each org whose ACL graph covers
	 * that workspace, and the authz gate resolves per-org.
	 */
	resolveMemberOrgsForUser: (
		userId: string,
	) => Promise<ResolvedTenantMember[]>;
	getEnabledLoginProviderConfigs: typeof getEnabledLoginProviderConfigs;
	fetchUserInfoWithRaw: typeof fetchUserInfoWithRaw;
}

const defaultPersistDeps: PersistLoginSlackIdentityDeps = {
	resolveMemberOrgsForUser,
	getEnabledLoginProviderConfigs,
	fetchUserInfoWithRaw,
};

/**
 * On Slack sign-in, write the user's team-scoped `slack_user_id` (`T…:U…`) onto
 * their `$member` entity, sourced `auth:signup`, in EVERY org where they are a
 * member. Idempotent.
 *
 * Effect: the ACL Slack channel-graph collapses the workspace member onto the
 * existing `$member` instead of forking a separate `person`, because both sides
 * now resolve on the same canonical `slack_user_id`.
 *
 * Runs across every member org, not just the personal one: a workspace is
 * commonly connected to a SHARED org, and the authz gate resolves per-org — so
 * writing only to the personal org leaves the user invisible in exactly the org
 * whose channels they are trying to read.
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

		const memberOrgs = await deps.resolveMemberOrgsForUser(account.userId);
		if (memberOrgs.length === 0) {
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
			// Resolve the Slack userinfo endpoint from the BASELINE catalog config
			// only (org id = null). We are about to send the user's real Slack OAuth
			// access token to `userinfoUrl`, so that URL must come from a trusted
			// source. An org-specific provider definition SHADOWS the baseline
			// (mergeLoginProviderConfigs), so reading it from any org the user
			// belongs to would let a tenant-controlled `userinfoUrl` receive the
			// token — an exfiltration vector, and unrelated to whichever org
			// actually initiated the OAuth exchange. The endpoint is a fixed
			// provider property, identical for every tenant, so the baseline is
			// both correct and safe.
			const cfgs = await deps.getEnabledLoginProviderConfigs(null);
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

		const sql = getDb();
		for (const org of memberOrgs) {
			const outcome = await adoptSlackIdentityOntoMember(
				sql,
				org.tenantOrganizationId,
				org.memberEntityId,
				combined,
			);
			if (outcome === "conflict") {
				// Another `$member` in this org already holds this Slack id. Two
				// humans cannot share one workspace account, so this is a data
				// problem a person must look at — never silently reassign.
				log.warn(
					{
						userId: account.userId,
						organizationId: org.tenantOrganizationId,
						memberEntityId: org.memberEntityId,
					},
					"slack-identity: slack_user_id already claimed by a different $member — leaving it alone",
				);
				continue;
			}
			log.debug(
				{
					userId: account.userId,
					organizationId: org.tenantOrganizationId,
					source,
					outcome,
				},
				"slack-identity: linked slack_user_id to $member",
			);
		}
	} catch (err) {
		log.error(
			{ err, userId: account.userId, providerId: account.providerId },
			"slack-identity: failed to persist slack_user_id on login",
		);
	}
}

/**
 * Stamp a workspace-scoped Slack identity onto a user's `$member` in every org
 * they belong to, idempotently and failing closed on conflict.
 *
 * This is the same write `persistLoginSlackIdentity` performs, exposed for the
 * install-claim path. That path needs it for a key OAuth alone cannot supply:
 * on Slack Grid the install row is keyed by the ENTERPRISE id (`E…`) while a
 * sign-in only ever proves the WORKSPACE id (`T…`), and inbound events may
 * carry either. Without the enterprise stamp the `E…` lookup resolves nothing
 * and the installer silently loses the identity-linked privileges.
 *
 * Refuses to write an unscoped id: `normalizeSlackUserId` returns null without
 * a team, and two workspaces can share a bare `U…`.
 */
export async function stampSlackIdentityForUser(
	userId: string,
	teamId: string | null | undefined,
	slackUserId: string,
): Promise<void> {
	const combined = normalizeSlackUserId(teamId, slackUserId);
	if (!combined) {
		log.debug(
			{ userId },
			"slack-identity: missing team_id or user id — skipping slack_user_id stamp",
		);
		return;
	}
	const memberOrgs = await resolveMemberOrgsForUser(userId);
	if (memberOrgs.length === 0) {
		log.debug(
			{ userId },
			"slack-identity: no tenant $member yet — skipping slack_user_id stamp",
		);
		return;
	}
	const sql = getDb();
	for (const org of memberOrgs) {
		const outcome = await adoptSlackIdentityOntoMember(
			sql,
			org.tenantOrganizationId,
			org.memberEntityId,
			combined,
		);
		if (outcome === "conflict") {
			// A different `$member` in this org already holds this Slack id. Two
			// humans cannot share one workspace account — never silently reassign.
			log.warn(
				{
					userId,
					organizationId: org.tenantOrganizationId,
					memberEntityId: org.memberEntityId,
				},
				"slack-identity: slack_user_id already claimed by a different $member — leaving it alone",
			);
		}
	}
}
