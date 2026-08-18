/**
 * Agent history for an ORG MEMBER who does not own the agent.
 *
 * The same asymmetry as the chat surface (`agent-member-use.test.ts`): a member
 * could read the agent's config org-wide but got 401 on every history read,
 * because `getAuthorizedAgentScope` required an `agent_users` ownership row in
 * the ambient workspace.
 *
 * Every thread route rebuilds the conversation id from `scope.userId`, so a
 * member authorized this way reads only their OWN conversations. The two live
 * worker-session proxies do not — they return whatever the agent is running
 * right now, which for an org-shared agent may be a colleague's turn — so they
 * stay owner-only.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { invalidateMembershipRoleCache } from "../../workspace/multi-tenant.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const AGENT_ORG = "org-history-member-test";
const AGENT_ID = "nasdaq-tracker";
const AGENT_OWNER_ID = "user-history-owner";
const MEMBER_ID = "user-history-member";
const OUTSIDER_ID = "user-history-outsider";

function sessionFor(userId: string) {
  return { userId, platform: "external", exp: Date.now() + 60_000 };
}

async function seedMembership(userId: string, role: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${userId}, ${`${userId}@test`}, true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m-${AGENT_ORG}-${userId}`}, ${AGENT_ORG}, ${userId}, ${role}, now())
    ON CONFLICT (id) DO NOTHING
  `;
  invalidateMembershipRoleCache(AGENT_ORG, userId);
}

describe("agent history — org member who does not own the agent", () => {
  let userAgentsStore: UserAgentsStore;
  let app: Hono;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    userAgentsStore = new UserAgentsStore();
    await orgContext.run({ organizationId: AGENT_ORG }, async () => {
      await seedAgentRow(AGENT_ID, {
        organizationId: AGENT_ORG,
        ownerPlatform: "external",
        ownerUserId: AGENT_OWNER_ID,
      });
      await userAgentsStore.addAgent("external", AGENT_OWNER_ID, AGENT_ID);
    });
    await seedMembership(AGENT_OWNER_ID, "member");
    await seedMembership(MEMBER_ID, "member");
    invalidateMembershipRoleCache(AGENT_ORG, OUTSIDER_ID);

    app = new Hono();
    app.route(
      "/api/v1/agents/:agentId/history",
      createAgentHistoryRoutes({
        userAgentsStore,
        agentConfigStore: createPostgresAgentConfigStore() as never,
      })
    );
  }, 60_000);

  afterEach(() => {
    setAuthProvider(null);
  });

  function request(path: string): Promise<Response> {
    return orgContext.run({ organizationId: AGENT_ORG }, () =>
      app.request(`/api/v1/agents/${AGENT_ID}/history${path}`, {
        headers: { host: "localhost" },
      })
    );
  }

  test("a member may list their own threads (was 401)", async () => {
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const res = await request("/threads");
    expect(res.status).toBe(200);
    // Their own conversations only — they have none yet.
    expect((await res.json()) as { threads: unknown[] }).toEqual({ threads: [] });
  });

  test("the owner still lists threads (regression)", async () => {
    setAuthProvider(() => sessionFor(AGENT_OWNER_ID));
    expect((await request("/threads")).status).toBe(200);
  });

  test("a non-member is still refused", async () => {
    setAuthProvider(() => sessionFor(OUTSIDER_ID));
    expect((await request("/threads")).status).toBe(401);
  });

  test("a member is refused the live worker-session proxies", async () => {
    setAuthProvider(() => sessionFor(MEMBER_ID));
    // These return the agent's CURRENT session — not this caller's
    // conversation — so membership must not open them.
    expect((await request("/session/messages")).status).toBe(401);
    expect((await request("/session/stats")).status).toBe(401);
  });
});
