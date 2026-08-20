/**
 * Agent history for an ORG MEMBER who does not own the agent.
 *
 * The same asymmetry as the chat surface (`agent-member-use.test.ts`): a member
 * could read the agent's config org-wide but got 401 on every history read,
 * because `getAuthorizedAgentScope` required an `agent_users` ownership row in
 * the ambient workspace.
 *
 * Every thread route rebuilds the conversation id from `scope.userId`, so a
 * member authorized this way reads only their OWN conversations. The routes
 * that are NOT keyed on it are narrowed or refused for a member without org
 * oversight: `?scope=all` falls back to the user-scoped list, and the
 * automation transcripts plus the two live worker-session proxies — which
 * return whatever the agent is running right now, possibly a colleague's turn
 * — are refused. The agent's owner and org owner/admins keep all of them.
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
import { buildApiConversationId } from "../services/api-conversation-id.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
  seedOrgMembership,
} from "./helpers/db-setup.js";

const AGENT_ORG = "org-history-member-test";
const AGENT_ID = "nasdaq-tracker";
const AGENT_OWNER_ID = "user-history-owner";
const MEMBER_ID = "user-history-member";
const ADMIN_ID = "user-history-admin";
const OUTSIDER_ID = "user-history-outsider";
const AUTOMATION_ID = 290001;

function sessionFor(userId: string) {
  return { userId, platform: "external", exp: Date.now() + 60_000 };
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
    await seedOrgMembership(AGENT_ORG, AGENT_OWNER_ID, "member");
    await seedOrgMembership(AGENT_ORG, MEMBER_ID, "member");
    await seedOrgMembership(AGENT_ORG, ADMIN_ID, "admin");
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

  test("scope=all does not widen a member beyond their own web threads", async () => {
    const sql = getDb();
    const ownKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: MEMBER_ID,
      organizationId: AGENT_ORG,
      threadId: "member-own",
    });
    const ownerKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: AGENT_OWNER_ID,
      organizationId: AGENT_ORG,
      threadId: "owner-private",
    });
    await sql`
      INSERT INTO conversations
        (organization_id, agent_id, platform, conversation_id, thread_id,
         kind, user_id, title, last_activity_at)
      VALUES
        (${AGENT_ORG}, ${AGENT_ID}, 'web', ${ownKey}, 'member-own',
         'owned', ${MEMBER_ID}, 'Member own', now()),
        (${AGENT_ORG}, ${AGENT_ID}, 'web', ${ownerKey}, 'owner-private',
         'owned', ${AGENT_OWNER_ID}, 'Owner private', now())
    `;
    await sql`
      INSERT INTO automations
        (id, organization_id, agent_id, created_by, automation_group_id,
         name, status, min_cooldown_seconds, last_run_completed_at,
         created_at, updated_at)
      VALUES
        (${AUTOMATION_ID}, ${AGENT_ORG}, ${AGENT_ID}, ${AGENT_OWNER_ID}, 0,
         'Owner automation', 'active', 0, now(), now(), now())
    `;

    setAuthProvider(() => sessionFor(MEMBER_ID));
    const res = await request("/threads?scope=all");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threads: Array<{ id: string; conversationId: string }>;
    };
    expect(body.threads).toEqual([
      expect.objectContaining({ id: "member-own", conversationId: ownKey }),
    ]);
  });

  test("a member cannot read an org automation transcript; an admin can", async () => {
    const sql = getDb();
    await sql`
      INSERT INTO automations
        (id, organization_id, agent_id, created_by, automation_group_id,
         name, status, min_cooldown_seconds, created_at, updated_at)
      VALUES
        (${AUTOMATION_ID}, ${AGENT_ORG}, ${AGENT_ID}, ${AGENT_OWNER_ID}, 0,
         'Private automation', 'active', 0, now(), now())
    `;
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs
        (run_type, status, organization_id, automation_id, approval_status,
         run_metadata, created_at, completed_at)
      VALUES
        ('automation', 'completed', ${AGENT_ORG}, ${AUTOMATION_ID}, 'auto',
         ${sql.json({ prompt_rendered: "owner automation secret" })}, now(), now())
      RETURNING id
    `;
    const conversationId = `${AGENT_ID}_automation_${AUTOMATION_ID}_run_${run!.id}`;
    const snapshot =
      '{"type":"message","message":{"role":"assistant","content":"secret result"}}\n';
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl,
         byte_size, terminal_status)
      VALUES
        (${AGENT_ORG}, ${AGENT_ID}, ${conversationId}, ${run!.id}, ${snapshot},
         ${Buffer.byteLength(snapshot)}, 'completed')
    `;

    setAuthProvider(() => sessionFor(MEMBER_ID));
    expect(
      (await request(`/automations/${AUTOMATION_ID}/thread`)).status
    ).toBe(401);

    setAuthProvider(() => sessionFor(ADMIN_ID));
    const admin = await request(`/automations/${AUTOMATION_ID}/thread`);
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as {
      runs: Array<{ runId: number; task: string | null }>;
    };
    expect(body.runs).toEqual([
      expect.objectContaining({
        runId: Number(run!.id),
        task: "owner automation secret",
      }),
    ]);
  });

  test("the owner still lists threads (regression)", async () => {
    setAuthProvider(() => sessionFor(AGENT_OWNER_ID));
    expect((await request("/threads")).status).toBe(200);
  });

  test("a non-member is still refused", async () => {
    setAuthProvider(() => sessionFor(OUTSIDER_ID));
    expect((await request("/threads")).status).toBe(401);
  });

  test("an agent-scoped session cannot borrow human membership", async () => {
    setAuthProvider(() => ({ ...sessionFor(MEMBER_ID), agentId: AGENT_ID }));
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
