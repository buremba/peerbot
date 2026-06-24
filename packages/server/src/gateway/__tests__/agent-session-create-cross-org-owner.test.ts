/**
 * POST /api/v1/agents — a signed-in owner can start a chat session for an
 * agent that lives in a NON-default org (regression for the SPA "Chat" 403).
 *
 * Prod repro: the owletto SPA POSTs `/lobu/api/v1/agents` with the better-auth
 * cookie. `createLobuOrgContextMiddleware` pins the request's ambient
 * org-context to the user's DEFAULT org. But the agent the user is chatting
 * with (e.g. `crm`) lives in a DIFFERENT org (`org_lobucrm`). The old
 * ownership check called `UserAgentsStore.ownsAgent`, which reads the ambient
 * org from AsyncLocalStorage — so it queried `agent_users` in the wrong org,
 * found nothing, and returned 403 for every chat run against a non-default-org
 * agent.
 *
 * The fix authorizes against the org the agent ACTUALLY lives in, resolved
 * from `agent_users` independent of the ambient org-context. This test pins the
 * ALS org to a different org than the agent's and asserts the owner is now
 * authorized (201), and stamps the session with the agent's REAL org — while a
 * non-owner / cross-org caller still gets 403.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import type { SettingsTokenPayload } from "../auth/settings/token-service.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { ThreadSession } from "../session.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

// The agent lives here; the caller's ambient/default org is intentionally
// something else to reproduce the prod mismatch.
const AGENT_ORG = "org-lobucrm-test";
const CALLER_DEFAULT_ORG = "org-personal-default-test";
const OTHER_ORG = "org-outsider-test";

const AGENT_ID = "crm";
const OWNER_USER_ID = "owner-user-8a2D";
const OUTSIDER_USER_ID = "outsider-user-zzz";

function ownerSession(): SettingsTokenPayload {
  // Mirrors the embedded authProvider: better-auth user → external identity,
  // no oauthUserId, so the lookup key is `userId`.
  return {
    userId: OWNER_USER_ID,
    platform: "external",
    exp: Date.now() + 60_000,
  };
}

function outsiderSession(): SettingsTokenPayload {
  return {
    userId: OUTSIDER_USER_ID,
    platform: "external",
    exp: Date.now() + 60_000,
  };
}

/**
 * Session manager that stores sessions by conversationId so the follow-up
 * GET route can resolve the row created by POST.
 */
function makeSessionManager() {
  const store = new Map<string, ThreadSession>();
  let lastStored: ThreadSession | null = null;
  return {
    mgr: {
      async getSession(key: string) {
        return store.get(key) ?? null;
      },
      async setSession(session: ThreadSession) {
        store.set(session.conversationId, session);
        lastStored = session;
      },
      async touchSession() {},
      async deleteSession(key: string) {
        store.delete(key);
      },
    } as never,
    getStored: () => lastStored,
  };
}

/**
 * Mount `createAgentApi` behind a wrapper that reproduces the production
 * ambient org-context: `createLobuOrgContextMiddleware` calls
 * `c.set("organizationId", <default org>)` AND wraps the request in
 * `orgContext.run()`. The early tenant guard in `requireAgentOwnership` reads
 * `c.get("organizationId")`, so the bug is only reproducible when that ambient
 * value is set on the Hono context — not merely present in AsyncLocalStorage.
 */
function makeApp(
  userAgentsStore: UserAgentsStore,
  agentMetadataStore: AgentMetadataStore,
  ambientOrg: string
) {
  const session = makeSessionManager();
  const agentApi = createAgentApi({
    queueProducer: {} as never,
    sessionManager: session.mgr,
    sseManager: { hasActiveConnection: () => false } as never,
    publicGatewayUrl: "http://localhost:8787",
    artifactStore: {} as never,
    userAgentsStore,
    agentMetadataStore: agentMetadataStore as never,
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("organizationId", ambientOrg);
    return orgContext.run({ organizationId: ambientOrg }, () => next());
  });
  app.route("/", agentApi);

  return { app, getStored: session.getStored };
}

async function postCreate(
  app: Hono,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return app.request("/api/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    // The body userId is the SPA's synthetic per-browser id — irrelevant to
    // ownership, which is resolved from the authenticated session.
    body: JSON.stringify({
      agentId: AGENT_ID,
      userId: "web-aede75e7",
      thread: "agent-panel",
    }),
  });
}

async function getStatus(app: Hono, sessionKey: string): Promise<Response> {
  return app.request(`/api/v1/agents/${encodeURIComponent(sessionKey)}`, {
    method: "GET",
  });
}

describe("POST /api/v1/agents — owner of a non-default-org agent", () => {
  let userAgentsStore: UserAgentsStore;
  let agentMetadataStore: AgentMetadataStore;

  beforeAll(async () => {
    // First call boots an embedded Postgres + runs migrations — allow ample
    // time so the boot doesn't leak into the per-test beforeEach window.
    await ensureDbForGatewayTests();
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    const configStore = createPostgresAgentConfigStore();
    agentMetadataStore = new AgentMetadataStore(configStore);
    userAgentsStore = new UserAgentsStore();

    // The agent + its owner mapping live in AGENT_ORG only.
    await orgContext.run({ organizationId: AGENT_ORG }, async () => {
      await seedAgentRow(AGENT_ID, {
        organizationId: AGENT_ORG,
        ownerPlatform: "external",
        ownerUserId: OWNER_USER_ID,
      });
      await userAgentsStore.addAgent("external", OWNER_USER_ID, AGENT_ID);
    });

    // Ensure the caller's default org and the outsider org exist as rows
    // (they have NO agent_users entry for AGENT_ID).
    await seedAgentRow("placeholder-default", { organizationId: CALLER_DEFAULT_ORG });
    await seedAgentRow("placeholder-other", { organizationId: OTHER_ORG });
  }, 60_000);

  afterEach(() => {
    setAuthProvider(null);
  });

  test("owner is authorized even when the ambient org is their DIFFERENT default org (was 403)", async () => {
    setAuthProvider(() => ownerSession());
    // Ambient org = caller's default org, which is NOT where the agent lives.
    const { app, getStored } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    const res = await postCreate(app);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // The session must be stamped with the agent's REAL org, not the
    // caller's ambient default org — otherwise the worker would run under the
    // wrong tenant (wrong secrets/MCP scope).
    const stored = getStored();
    expect(stored?.organizationId).toBe(AGENT_ORG);
  });

  test("FOLLOW-UP GET /api/v1/agents/:sessionKey succeeds for the owner under their default ambient org (was 403)", async () => {
    setAuthProvider(() => ownerSession());
    const { app } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    // 1. Create the session (already proven to 201).
    const createRes = await postCreate(app);
    expect(createRes.status).toBe(201);
    const { agentId: sessionKey } = (await createRes.json()) as {
      agentId: string;
    };

    // 2. The SPA's NEXT request (status / SSE / messages all share the same
    //    early ambient-org guard). The session row is stamped with AGENT_ORG
    //    while the request's ambient org is still CALLER_DEFAULT_ORG. Before
    //    the follow-up fix, the early guard saw
    //    `c.get("organizationId") (CALLER_DEFAULT_ORG) !==
    //    session.organizationId (AGENT_ORG)` and returned 403, so SPA chat
    //    broke on the second request even though POST succeeded.
    const getRes = await getStatus(app, sessionKey);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { success: boolean };
    expect(getBody.success).toBe(true);
  });

  test("FOLLOW-UP GET still 403s for a cross-org non-owner sharing the session key (tenant isolation preserved)", async () => {
    // The owner creates a session (stamped with AGENT_ORG).
    setAuthProvider(() => ownerSession());
    const owned = makeApp(userAgentsStore, agentMetadataStore, AGENT_ORG);
    const createRes = await postCreate(owned.app);
    expect(createRes.status).toBe(201);
    const { agentId: sessionKey } = (await createRes.json()) as {
      agentId: string;
    };

    // An outsider (member of OTHER_ORG, owns no agent_users row for crm) tries
    // to read the owner's session via the same key. Drive the request through
    // the OWNER's app instance so the session row actually exists — this forces
    // the OWNERSHIP gate (not a 404 short-circuit on a missing session). The
    // early ambient-org guard is now skipped for cookie auth, so the
    // authoritative resolved-org check in authorizeOwnership must still deny:
    // the outsider resolves no owning org for crm, so `verifyOwnedAgentAccess`
    // is unauthorized → 403.
    setAuthProvider(() => outsiderSession());
    const getRes = await getStatus(owned.app, sessionKey);
    expect(getRes.status).toBe(403);
    expect((await getRes.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
  });

  test("a non-owner in a different org still gets 403 on create (tenant isolation preserved)", async () => {
    setAuthProvider(() => outsiderSession());
    // Outsider authenticated, ambient org is their own — they own no
    // agent_users row for crm in ANY org.
    const { app, getStored } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      OTHER_ORG
    );

    const res = await postCreate(app);

    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
    expect(getStored()).toBeNull();
  });

  test("even when an outsider's ambient org IS the agent's org, ownership still denies (no agent_users row)", async () => {
    // Defense-in-depth: a caller cannot piggyback on the agent's org just by
    // having the ambient context point there. Authorization is keyed on the
    // caller's own (platform, userId) agent_users row, which the outsider lacks.
    setAuthProvider(() => outsiderSession());
    const { app } = makeApp(userAgentsStore, agentMetadataStore, AGENT_ORG);

    const res = await postCreate(app);

    expect(res.status).toBe(403);
  });

  test("org-bound Bearer/PAT (authoritative org=A) is DENIED an agent that resolves to org=B, mints NO session", async () => {
    // Tenant-isolation BLOCKER (pi-confirmed): the create path passes no
    // `sessionForTenantCheck` (no pre-existing session), so the early guard
    // can't fire. A Bearer/PAT pinned to org A whose user ALSO owns the same
    // agentId in org B must NOT be allowed to mint a session for the org-B
    // agent — that would be cross-tenant escalation. `authorizeOwnership`'s
    // authoritative-caller-org guard catches it.
    //
    // Setup: the same OWNER_USER_ID owns `crm` in AGENT_ORG (seeded in
    // beforeEach), but this request is pinned to CALLER_DEFAULT_ORG via a
    // Bearer + ambient org. `findAgentOrganizations` resolves crm to AGENT_ORG;
    // authoritativeCallerOrgId = CALLER_DEFAULT_ORG → mismatch → 403.
    //
    // NOTE: the COOKIE form of this exact scenario (same user, same orgs, NO
    // Bearer) is the legitimate SPA case and returns 201 — proven by the first
    // test above. The ONLY difference is the presence of an authoritative
    // (Bearer-bound) caller org.
    setAuthProvider(() => ownerSession());
    const { app, getStored } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      // Ambient org is the PAT's pinned org A — authoritative because a Bearer
      // is present on the request.
      CALLER_DEFAULT_ORG
    );

    const res = await postCreate(app, {
      // A non-worker, non-OAuth Bearer (PAT-shaped). The settings-session
      // provider authenticates the user; the Bearer's presence is what makes
      // the ambient org authoritative in requireAgentOwnership.
      Authorization: "Bearer owl_pat_test_token",
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
    // No session may be minted for the org-B agent.
    expect(getStored()).toBeNull();
  });
});
