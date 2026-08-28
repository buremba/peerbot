import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { resolveClaimContext } from "../connections/connection-claim.js";
import { slackClaimProvider } from "../connections/slack-claim.js";
import { resolveClaimingUserSlackIdentities } from "../connections/slack-claim-identities.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const USER_ID = "claim-user";
const TEAM_ID = "T-CLAIM";
const SLACK_USER_ID = "U-ADMIN";
const ORG_ID = "org-1";

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO "user" (
      id, email, name, username, "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${USER_ID}, 'claim@test.example.com', 'Claim User', 'claim-user',
      true, now(), now()
    )
  `;
}, 30_000);

/**
 * Seed the claimer's workspace-scoped Slack identity the way Slack sign-in
 * does: a `$member` entity carrying both `auth_user_id` and the composite
 * `TEAM:USER` `slack_user_id`. `resolveClaimingUserSlackIdentities` reads this
 * graph shape, so seeding anything less would pass here and fail in production.
 */
async function linkSlackUser(teamId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug, "createdAt")
    VALUES (${ORG_ID}, 'Acme', 'acme', now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m-${USER_ID}`}, ${ORG_ID}, ${USER_ID}, 'owner', now())
    ON CONFLICT (id) DO NOTHING
  `;
  const types = await sql<{ id: number }>`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${ORG_ID}, '$member', 'Member', now(), now())
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  const entities = await sql<{ id: number }>`
    INSERT INTO entities (
      name, slug, organization_id, created_by, entity_type_id, created_at, updated_at
    ) VALUES (
      'Claim User', ${`member-${USER_ID}`}, ${ORG_ID}, ${USER_ID}, ${types[0].id}, now(), now()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  let entityId = entities[0]?.id;
  if (entityId === undefined) {
    const existing = await sql<{ id: number }>`
      SELECT id FROM entities
      WHERE organization_id = ${ORG_ID} AND slug = ${`member-${USER_ID}`}
      LIMIT 1
    `;
    entityId = existing[0].id;
  }
  await sql`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector
    ) VALUES
      (${ORG_ID}, ${entityId}, 'auth_user_id', ${USER_ID}, 'auth:signup'),
      (${ORG_ID}, ${entityId}, 'slack_user_id', ${`${teamId.toUpperCase()}:${SLACK_USER_ID.toUpperCase()}`}, 'auth:signup')
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
  `;
}

function claimProvider(usersInfo: ReturnType<typeof mock>) {
  return slackClaimProvider({
    resolvePending: mock(async () => ({
      id: "pending-1",
      teamId: TEAM_ID,
      teamName: "Acme",
      botUserId: "B-BOT",
      installerUserId: "U-INSTALLER",
      botToken: "xoxb-test",
      isEnterpriseInstall: false,
      enterpriseId: null,
    })),
    resolveActiveOrgSlug: mock(async () => null),
    resolveClaimerSlackIdentities: resolveClaimingUserSlackIdentities,
    stampSlackIdentityForUser: mock(async () => {}),
    usersInfo,
    claim: mock(async () => ({ installationId: "unused" })),
  });
}

const claimEngineDeps = {
  resolveMemberOrgs: mock(async () => [
    { id: "org-1", slug: "acme", name: "Acme", isPersonal: false },
  ]),
  resolveOrgIfMember: mock(async () => "org-1"),
  resolveOrgSlug: mock(async () => "acme"),
};

describe("Slack HTTP claim authority", () => {
  test("a workspace-linked Slack identity reaches ready instead of signin_required", async () => {
    await linkSlackUser(TEAM_ID);
    const usersInfo = mock(async () => ({ isAdmin: true, isOwner: false }));
    const context = await resolveClaimContext(
      claimProvider(usersInfo),
      claimEngineDeps,
      { userId: USER_ID, ref: TEAM_ID },
    );

    expect(context.status).toBe("ready");
    expect(usersInfo).toHaveBeenCalledWith("xoxb-test", SLACK_USER_ID);
  });

  test("a Slack identity linked in another workspace still requires sign-in", async () => {
    await linkSlackUser("T-OTHER");
    const usersInfo = mock(async () => ({ isAdmin: true, isOwner: false }));

    const context = await resolveClaimContext(
      claimProvider(usersInfo),
      claimEngineDeps,
      { userId: USER_ID, ref: TEAM_ID },
    );

    expect(context).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
    expect(usersInfo).not.toHaveBeenCalled();
  });
});
