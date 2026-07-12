import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import { decodeJwtClaims } from "../../auth/subject-identities.js";
import { getDb, type DbClient } from "../../db/client.js";

/**
 * Resolve all of the signed-in user's Slack identities as team/user pairs.
 * The entity graph and Better Auth account are OAuth-backed sources; the direct
 * chat-user mapping is written by the one-time `/lobu link` flow. The provider
 * guard consumes these pairs before org selection, exact-team scopes ordinary
 * workspace claims, and separately restricts bare-user matches to Grid.
 */
export async function resolveClaimingUserSlackIdentities(
  userId: string,
  sql: DbClient = getDb(),
): Promise<Array<{ teamId: string; slackUserId: string }>> {
  const rows = (await sql`
    SELECT DISTINCT ei.identifier
    FROM "member" m
    JOIN entity_identities auth_ei
      ON auth_ei.organization_id = m."organizationId"
     AND auth_ei.namespace = 'auth_user_id'
     AND auth_ei.identifier = m."userId"
     AND auth_ei.source_connector = 'auth:signup'
     AND auth_ei.deleted_at IS NULL
    JOIN entity_identities ei
      ON ei.organization_id = auth_ei.organization_id
     AND ei.entity_id = auth_ei.entity_id
     AND ei.namespace = ${SLACK_IDENTITY.USER_ID}
     AND ei.deleted_at IS NULL
    WHERE m."userId" = ${userId}
  `) as Array<{ identifier: string }>;
  const fromGraph = rows
    .map((r) => String(r.identifier))
    .map((id) => {
      const sep = id.indexOf(":");
      return sep === -1
        ? null
        : { teamId: id.slice(0, sep), slackUserId: id.slice(sep + 1) };
    })
    .filter((x): x is { teamId: string; slackUserId: string } => x !== null);

  const accountRows = (await sql`
    SELECT "accountId", "idToken"
    FROM account
    WHERE "providerId" = 'slack' AND "userId" = ${userId}
  `) as Array<{ accountId: string | null; idToken: string | null }>;
  const fromAccounts = accountRows
    .map((a) => {
      const slackUserId = a.accountId?.toUpperCase();
      if (!slackUserId) return null;
      const teamId = a.idToken
        ? ((decodeJwtClaims(a.idToken)?.["https://slack.com/team_id"] as
            | string
            | undefined) ?? "")
        : "";
      return { teamId: teamId.toUpperCase(), slackUserId };
    })
    .filter((x): x is { teamId: string; slackUserId: string } => x !== null);

  // `/lobu link` records a direct, immutable Slack workspace-user → Lobu-user
  // association here. This is the canonical identity used by Slack interaction
  // and message routing, and it may exist even when the entity graph was never
  // populated and the linked Better Auth account predates a stored id_token.
  // Preserve both dimensions: authorizeSlackClaim will accept this only for the
  // pending install's exact team, then still require Slack's live admin/owner
  // verdict for the linked U… id. A link in another workspace grants nothing.
  const linkedRows = (await sql`
    SELECT team_id, platform_user_id
    FROM chat_user_identities
    WHERE platform = 'slack' AND lobu_user_id = ${userId}
  `) as Array<{ team_id: string; platform_user_id: string }>;
  const fromLinkedChatUsers = linkedRows.map((row) => ({
    teamId: row.team_id.toUpperCase(),
    slackUserId: row.platform_user_id.toUpperCase(),
  }));

  const seen = new Set<string>();
  return [...fromGraph, ...fromAccounts, ...fromLinkedChatUsers].filter((x) => {
    const key = `${x.teamId}:${x.slackUserId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
