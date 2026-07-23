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

async function linkSlackUser(teamId: string): Promise<void> {
  await getDb()`
    INSERT INTO chat_user_identities (
      platform, team_id, platform_user_id, lobu_user_id, updated_at
    ) VALUES ('slack', ${teamId}, ${SLACK_USER_ID}, ${USER_ID}, now())
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
    linkChatUserIdentity: mock(async () => {}),
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
