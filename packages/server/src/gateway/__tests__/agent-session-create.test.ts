/**
 * POST /api/v1/agents (session create) — ownership-denial is enumeration-safe.
 *
 * A denied session-create must return the SAME response whether the requested
 * agent is missing or merely belongs to another tenant. Distinguishing the two
 * (e.g. 404-for-missing vs 403-for-unauthorized) would let a caller probe
 * arbitrary ids to discover other tenants' agents.
 *
 * Mounts the real `createAgentApi` and authenticates with a real worker token
 * (encrypted with a test ENCRYPTION_KEY) scoped to a different agent, so
 * ownership is always denied. Later default-agent tests exercise DB-backed
 * org-system-agent resolution, so this file bootstraps the gateway test DB.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { hashToken } from "../../auth/oauth/utils.js";
import { getDb } from "../../db/client.js";
import { parseBehaviorRunConversationId } from "../permissions/behavior-run-intent.js";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Agent that "exists" in the metadata store; everything else is unknown. */
const EXISTING_AGENT = "agent-existing";

let savedKey: string | undefined;
beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
  // No settings-session provider — force the worker-token auth path.
  setAuthProvider(null);
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  setAuthProvider(null);
});

function makeApp() {
  return createAgentApi({
    // Unused before the ownership check returns — minimal stubs.
    queueProducer: {} as never,
    sessionManager: {} as never,
    sseManager: {} as never,
    publicGatewayUrl: "http://localhost:8787",
    artifactStore: {} as never,
    agentMetadataStore: {
      async getMetadata(agentId: string) {
        return agentId === EXISTING_AGENT
          ? { owner: { platform: "api", userId: "owner-1" } }
          : null;
      },
    } as never,
  });
}

/** Worker token scoped to a *different* agent, so ownership is always denied. */
function tokenForOtherAgent(): string {
  return generateWorkerToken("agent-other", "conv-1", "deploy-1", {
    channelId: "api_test",
    agentId: "agent-other",
  });
}

async function createSession(agentId: string): Promise<Response> {
  return makeApp().request("/api/v1/agents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenForOtherAgent()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentId }),
  });
}

describe("POST /api/v1/agents — enumeration-safe ownership denial", () => {
  test("an unauthorized request for an EXISTING agent is denied with 403", async () => {
    const res = await createSession(EXISTING_AGENT);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
  });

  test("a request for a MISSING agent returns the identical denial (no leak)", async () => {
    const res = await createSession("agent-not-deployed");
    // Same status + body as the existing-but-unauthorized case — the response
    // reveals nothing about whether the agent exists.
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
  });
});

/**
 * No-`agentId` (default-agent) resolution path.
 *
 * POST /api/v1/agents with an empty body must resolve to
 * `DEFAULT_AGENT_ID` for the caller's org, scope the session id with that
 * org so two tenants can't collide, and return 404 when the org has no
 * default agent provisioned yet (rather than silently minting a new UUID
 * or serving another tenant's row).
 */
describe("POST /api/v1/agents — default-agent resolution", () => {
  const ORG_ID = "org-test";
  const USER_ID = "user-test";

  // A worker token bound to the caller's org. The auth middleware reads
  // `organizationId` off the decrypted token and stamps `authContext` so
  // the handler can resolve the org without a body field.
  function orgBoundToken(): string {
    return generateWorkerToken("owletto-default", "conv-bootstrap", "deploy-1", {
      channelId: "api_test",
      agentId: "owletto-default",
      organizationId: ORG_ID,
    });
  }

  // In-memory session store that records the last setSession call so the
  // test can assert the tenant-scoped conversationId.
  function makeSessionRecorder() {
    const sessions = new Map<string, unknown>();
    return {
      store: {
        async getSession(id: string) {
          return sessions.get(id) ?? null;
        },
        async setSession(s: { conversationId: string }) {
          sessions.set(s.conversationId, s);
        },
        async touchSession() {},
        async deleteSession(id: string) {
          sessions.delete(id);
        },
      },
      sessions,
    };
  }

  function makeAppWithDefault(opts: {
    defaultAgentOrg: string | null;
  }) {
    const recorder = makeSessionRecorder();
    const app = createAgentApi({
      queueProducer: {} as never,
      sessionManager: recorder.store as never,
      sseManager: {} as never,
      publicGatewayUrl: "http://localhost:8787",
      artifactStore: {} as never,
      agentSettingsStore: {
        async saveSettings() {},
      } as never,
      agentMetadataStore: {
        async getMetadata(id: string) {
          if (id !== "owletto-default" || opts.defaultAgentOrg === null)
            return null;
          // Same owner the worker token authenticates as so the per-user
          // ownership check passes.
          return {
            owner: { platform: "api", userId: "owletto-default" },
            organizationId: opts.defaultAgentOrg,
          };
        },
      } as never,
      userAgentsStore: {
        async ownsAgent() {
          return true;
        },
      } as never,
    });
    return { app, recorder };
  }

  test("no-agentId body resolves to owletto-default for caller's org", async () => {
    const { app, recorder } = makeAppWithDefault({ defaultAgentOrg: ORG_ID });
    const res = await app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orgBoundToken()}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId?: string };
    // conversationId = `${agentId}_${userId}_${orgId}` — the tenant suffix
    // is what prevents cross-org session collisions when DEFAULT_AGENT_ID
    // is a global constant.
    expect(body.agentId).toContain("owletto-default");
    expect(body.agentId).toContain(ORG_ID);
    // Session actually persisted under that exact key.
    expect(recorder.sessions.has(body.agentId!)).toBe(true);
  });

  test("returns 404 when the org has no default agent provisioned", async () => {
    // `getMetadata("owletto-default")` returns null for this org → handler
    // refuses rather than minting a phantom UUID (the old broken behavior)
    // or serving another tenant's default row.
    const { app } = makeAppWithDefault({ defaultAgentOrg: null });
    const res = await app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orgBoundToken()}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Default agent");
  });

  test("cross-tenant GET on a session URL is denied with 403", async () => {
    // Set up: orgA creates a session via POST /api/v1/agents, then orgB
    // tries to GET that exact session URL. Both orgs nominally "own"
    // agentId `owletto-default` (the global constant) — without the
    // tenant guard in requireAgentOwnership, orgB would pass the
    // (platform, userId, agentId) check and read orgA's session row.
    const orgA = "org-A";
    const orgB = "org-B";
    const tokenA = generateWorkerToken("owletto-default", "conv-A", "deploy-A", {
      channelId: "api_test",
      agentId: "owletto-default",
      organizationId: orgA,
    });
    const tokenB = generateWorkerToken("owletto-default", "conv-B", "deploy-B", {
      channelId: "api_test",
      agentId: "owletto-default",
      organizationId: orgB,
    });

    // Shared metadata store: BOTH orgs have an `owletto-default` agent that
    // their respective workers own (the cross-tenant collision setup pi
    // exploited).
    const sharedSessions = new Map<string, any>();
    sharedSessions.set("owletto-default_owletto-default_org-A", {
      conversationId: "owletto-default_owletto-default_org-A",
      userId: "owletto-default",
      agentId: "owletto-default",
      organizationId: orgA,
      status: "created",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    const app = createAgentApi({
      queueProducer: {} as never,
      sessionManager: {
        async getSession(id: string) {
          return sharedSessions.get(id) ?? null;
        },
        async setSession(s: any) {
          sharedSessions.set(s.conversationId, s);
        },
        async touchSession() {},
        async deleteSession(id: string) {
          sharedSessions.delete(id);
        },
      } as never,
      sseManager: {
        hasActiveConnection() {
          return false;
        },
      } as never,
      publicGatewayUrl: "http://localhost:8787",
      artifactStore: {} as never,
      agentMetadataStore: {
        async getMetadata(id: string) {
          if (id !== "owletto-default") return null;
          return {
            owner: { platform: "api", userId: "owletto-default" },
          };
        },
      } as never,
      userAgentsStore: {
        async ownsAgent() {
          return true;
        },
      } as never,
    });

    // Sanity: orgA can GET its own session (token A authenticates as the
    // owner, session.organizationId matches authContext).
    const okSelf = await app.request(
      "/api/v1/agents/owletto-default_owletto-default_org-A",
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    expect(okSelf.status).toBe(200);

    // Real test: orgB tries the same URL. Ownership check would otherwise
    // pass (orgB also owns agent `owletto-default`) — the tenant guard
    // inside requireAgentOwnership refuses based on session.organizationId
    // (orgA) ≠ caller orgId (orgB).
    const denied = await app.request(
      "/api/v1/agents/owletto-default_owletto-default_org-A",
      { headers: { Authorization: `Bearer ${tokenB}` } }
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });
  });

  test("cross-tenant GET via a settings-session COOKIE is denied with 403", async () => {
    // The worker/PAT/OAuth auth paths populate an org on the auth context, so
    // the up-front tenant guard catches their cross-tenant attempts (the test
    // above). The settings-session COOKIE path populates only a userId —
    // callerOrgId stays undefined and that guard is a no-op. This exercises the
    // resolved-org fallback inside requireAgentOwnership: verifyOwnedAgentAccess
    // authorizes orgB's cookie user (they own their own `owletto-default`) but
    // resolves their org to orgB, which must NOT match orgA's session. Without
    // the fallback this GET would return 200 and leak orgA's session.
    const orgA = "org-A";
    const orgB = "org-B";

    const sharedSessions = new Map<string, any>();
    const seed = (org: string) => {
      const id = `owletto-default_user-cookie_${org}`;
      sharedSessions.set(id, {
        conversationId: id,
        userId: "user-cookie",
        agentId: "owletto-default",
        organizationId: org,
        status: "created",
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });
      return id;
    };
    const orgASession = seed(orgA);
    const orgBSession = seed(orgB);

    const app = createAgentApi({
      queueProducer: {} as never,
      sessionManager: {
        async getSession(id: string) {
          return sharedSessions.get(id) ?? null;
        },
        async setSession() {},
        async touchSession() {},
        async deleteSession() {},
      } as never,
      sseManager: {
        hasActiveConnection() {
          return false;
        },
      } as never,
      publicGatewayUrl: "http://localhost:8787",
      artifactStore: {} as never,
      agentMetadataStore: {
        async getMetadata(id: string) {
          if (id !== "owletto-default") return null;
          return { owner: { platform: "api", userId: "user-cookie" } };
        },
      } as never,
      userAgentsStore: {
        async ownsAgent() {
          return true;
        },
        // The cookie user belongs to orgB only — this is the org
        // verifyOwnedAgentAccess resolves and compares against the session's.
        async findAgentOrganizations() {
          return [orgB];
        },
      } as never,
    });

    // A settings-session cookie carries a userId, NOT an org —
    // createApiAuthMiddleware stamps authContext = { userId } with no
    // organizationId, so callerOrgId is undefined and the up-front guard
    // can't fire.
    setAuthProvider(() => ({
      userId: "user-cookie",
      platform: "api",
      exp: Date.now() + 60_000,
    }));

    // Sanity: the cookie user reaches their OWN org's session (resolved org
    // orgB === session org orgB → allowed; never a false-deny).
    const okSelf = await app.request(`/api/v1/agents/${orgBSession}`);
    expect(okSelf.status).toBe(200);

    // The fix: the same cookie user is denied orgA's session (resolved org
    // orgB ≠ session org orgA) even though ownsAgent() returns true.
    const denied = await app.request(`/api/v1/agents/${orgASession}`);
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error?: string }).toEqual({
      success: false,
      error: "Forbidden",
    });

    // The pending-approvals route returns tool requestIds + args for a
    // conversation, so it MUST enforce the same cross-org gate — without the
    // authorizeAgentAccess pre-gate it had no auth at all and leaked another
    // org's approval payloads (IDOR). The denial fires before the pending-tool
    // store is touched, so this needs no DB.
    const pendingDenied = await app.request(
      `/api/v1/agents/${orgASession}/pending-approvals`
    );
    expect(pendingDenied.status).toBe(403);
  });

  test("returns 404 when the default agent belongs to a different org", async () => {
    // Default agent exists, but its org doesn't match the caller's token
    // org — must NOT leak. The same 404 as 'not provisioned' is fine; the
    // critical property is that it refuses to mint a session against
    // another tenant's row.
    const { app } = makeAppWithDefault({ defaultAgentOrg: "org-other" });
    const res = await app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orgBoundToken()}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  // Silence the unused-symbol warning for USER_ID — it's part of the
  // documented session-id shape (`<agentId>_<userId>_<orgId>`) the test
  // asserts on but we don't pin the exact userId since it's derived from
  // authContext under the hood.
  void USER_ID;
});

/**
 * Watcher session-id shape.
 *
 * Watcher dispatch correlation — the worker session key AND the API/SSE
 * owner-routing key (unified-thread-consumer) — both derive from the
 * conversationId and rely on the exact `..._watcher_<watcherId>_run_<runId>`
 * shape. The org-scope suffix added for the default-agent / pinned-API paths
 * must NOT be spliced into watcher conversationIds: `_<org>_` between
 * `watcher_<id>` and `run_<id>` breaks watcher→worker dispatch (the sdk-e2e
 * watcher gate went red on exactly this). Tenant isolation for watchers rides
 * `session.organizationId` (still set) + the route guard, not the id string.
 */
describe("POST /api/v1/agents — behavior_run intent verification", () => {
  const ORG_ID = "org-watcher";
  const OTHER_ORG = "org-watcher-other";
  const AGENT = "watcher-agent";
  const SEED_USER = "intent-seed-user";
  const INTERNAL_SERVICE_TOKEN = "intent-internal-service-token";
  const ORDINARY_ACCESS_TOKEN = "intent-ordinary-access-token";

  /**
   * Seed one Behavior plus a run in the state the server dispatcher leaves it
   * in. Returns both ids so a test can name a real Behavior and a real run
   * without hardcoding sequence values.
   */
  async function seedDispatchedRun(
    opts: {
      organizationId?: string;
      status?: string;
      claimedBy?: string | null;
    } = {},
  ): Promise<{ behaviorId: number; runId: number }> {
    const sql = getDb();
    const orgId = opts.organizationId ?? ORG_ID;
    await seedAgentRow(AGENT, { organizationId: orgId });
    // watchers.created_by is FK-constrained to `user`.
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${SEED_USER}, ${SEED_USER}, ${`${SEED_USER}@example.com`},
              false, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
    const [behavior] = (await sql`
      WITH next_id AS (SELECT nextval('watchers_id_seq')::integer AS id)
      INSERT INTO watchers (
        id, watcher_group_id, organization_id, agent_id, created_by, name, slug
      )
      SELECT id, id, ${orgId}, ${AGENT}, ${SEED_USER},
             'Intent fixture', 'intent-fixture-' || id
      FROM next_id
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const behaviorId = Number(behavior.id);
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, watcher_id, status, claimed_by, created_at
      ) VALUES (
        ${orgId}, 'behavior', ${behaviorId},
        ${opts.status ?? "claimed"}, ${opts.claimedBy ?? "lobu-dispatcher"},
        now()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return { behaviorId, runId: Number(run.id) };
  }

  function makeWatcherApp() {
    const sessions = new Map<string, { conversationId: string }>();
    return createAgentApi({
      queueProducer: {} as never,
      sessionManager: {
        async getSession(id: string) {
          return sessions.get(id) ?? null;
        },
        async setSession(session: { conversationId: string }) {
          sessions.set(session.conversationId, session);
        },
        async touchSession() {},
        async deleteSession() {},
      } as never,
      sseManager: {} as never,
      publicGatewayUrl: "http://localhost:8787",
      artifactStore: {} as never,
      externalAuthClient: {
        async fetchUserInfo() {
          return {
            sub: SEED_USER,
            organizationId: ORG_ID,
          };
        },
      } as never,
      agentMetadataStore: {
        async getMetadata(id: string) {
          // Non-empty org metadata → tokenOrganizationId resolves, so the
          // suffix WOULD be added on a non-watcher path. The watcher exemption
          // is what keeps it out.
          return id === AGENT
            ? {
                owner: { platform: "external", userId: SEED_USER },
                organizationId: ORG_ID,
              }
            : null;
        },
      } as never,
    });
  }

  async function post(
    body: Record<string, unknown>,
    accessToken = INTERNAL_SERVICE_TOKEN,
  ): Promise<Response> {
    return makeWatcherApp().request("/api/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function intentBody(runId: number, behaviorId: number) {
    return {
      agentId: AGENT,
      forceNew: true,
      intent: { kind: "behavior_run", runId, behaviorId },
    };
  }

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.ENCRYPTION_KEY = TEST_KEY;
    setAuthProvider(null);
    await seedAgentRow(AGENT, { organizationId: ORG_ID });
    const sql = getDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${SEED_USER}, ${SEED_USER}, ${`${SEED_USER}@example.com`},
              false, now(), now())
    `;
    await sql`
      INSERT INTO oauth_clients (
        id, redirect_uris, client_name, token_endpoint_auth_method
      ) VALUES
        ('lobu-internal', '{}'::text[], 'Lobu Internal Service', 'none'),
        ('ordinary-client', '{}'::text[], 'Ordinary Client', 'none')
    `;
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at
      ) VALUES
        (
          'intent-service-token', 'access', ${hashToken(INTERNAL_SERVICE_TOKEN)},
          'lobu-internal', ${SEED_USER}, ${ORG_ID}, 'profile:read',
          NOW() + INTERVAL '1 hour'
        ),
        (
          'intent-ordinary-token', 'access', ${hashToken(ORDINARY_ACCESS_TOKEN)},
          'ordinary-client', ${SEED_USER}, ${ORG_ID}, 'profile:read',
          NOW() + INTERVAL '1 hour'
        )
    `;
  });

  test("a dispatched run keeps the watcher_<id>_run_<id> shape, no org suffix", async () => {
    const { behaviorId, runId } = await seedDispatchedRun();
    const res = await post(intentBody(runId, behaviorId));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId?: string };
    // Exact prod-proven shape: `<agentId>_watcher_<watcherId>_run_<runId>`.
    expect(body.agentId).toBe(`${AGENT}_watcher_${behaviorId}_run_${runId}`);
    expect(body.agentId).not.toContain(ORG_ID);
  });

  test("an ordinary same-org token cannot borrow an in-flight Behavior run", async () => {
    const { behaviorId, runId } = await seedDispatchedRun();
    expect(
      (
        await post(
          intentBody(runId, behaviorId),
          ORDINARY_ACCESS_TOKEN,
        )
      ).status,
    ).toBe(403);
  });

  test("an intent naming a run that does not exist is refused", async () => {
    const { behaviorId } = await seedDispatchedRun();
    const res = await post(intentBody(999_999, behaviorId));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Unknown or undispatched Behavior run",
    });
  });

  test("an intent naming another Behavior's run is refused", async () => {
    // The escalation this closes: borrowing a sibling Behavior's session shape
    // (and so its execution_config) by naming a run that is not its own.
    const mine = await seedDispatchedRun();
    const sibling = await seedDispatchedRun();
    // Name MY Behavior but the sibling's run.
    expect((await post(intentBody(sibling.runId, mine.behaviorId))).status).toBe(
      403,
    );
  });

  test("an intent naming another tenant's run is refused", async () => {
    const other = await seedDispatchedRun({ organizationId: OTHER_ORG });
    expect(
      (await post(intentBody(other.runId, other.behaviorId))).status,
    ).toBe(403);
  });

  test("a run the server never dispatched is refused", async () => {
    // A pending run exists the moment an event activates a Behavior, long
    // before dispatch. Accepting one would make the check trivially satisfiable
    // by anyone who can trigger the Behavior.
    const { behaviorId, runId } = await seedDispatchedRun({
      status: "pending",
      claimedBy: null,
    });
    expect((await post(intentBody(runId, behaviorId))).status).toBe(403);
  });

  test("a run claimed by something other than the dispatcher is refused", async () => {
    const { behaviorId, runId } = await seedDispatchedRun({
      claimedBy: "device-worker-1",
    });
    expect((await post(intentBody(runId, behaviorId))).status).toBe(403);
  });

  /**
   * The invariant is not "these inputs 400" — it is that NO session without a
   * verified intent ever carries the `_watcher_<id>_run_<id>` correlation the
   * unattended-tool policy reads. Two mechanisms deliver that, and which one
   * fires depends on whether an org resolves: `buildApiConversationId`
   * interleaves the org id between userId and thread (breaking the shape), and
   * the explicit guard rejects whatever still lands on it. Asserting the
   * property covers both, and keeps passing if either mechanism changes.
   */
  for (const [name, userId, thread] of [
    ["exact fields", "watcher_5", "run_1"],
    ["split suffix", "caller_watcher_5", "run_1"],
    ["suffix packed into userId", "caller_watcher_5_run_1", undefined],
    ["suffix packed into thread", "caller", "topic_watcher_5_run_1"],
  ] as const) {
    test(`an unverified session never carries the Behavior suffix — ${name}`, async () => {
      const res = await post({
        agentId: AGENT,
        userId,
        ...(thread ? { thread } : {}),
        forceNew: true,
      });

      if (res.status === 400) {
        expect((await res.json()) as { error?: string }).toEqual({
          success: false,
          error: "Reserved Behavior conversation suffix",
        });
        return;
      }
      expect(res.status).toBe(201);
      const body = (await res.json()) as { agentId?: string };
      expect(parseBehaviorRunConversationId(body.agentId ?? "")).toBeNull();
    });
  }

  test("the guard itself rejects a crafted suffix that survives id assembly", async () => {
    // `buildApiConversationId` appends the thread last, so a suffix planted
    // there reaches the end of the conversation id intact — this is the input
    // the explicit guard exists for, and it must not be quietly weakened to a
    // no-op by a future change to id assembly.
    const res = await post({
      agentId: AGENT,
      userId: "caller",
      thread: "topic_watcher_5_run_1",
      forceNew: true,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toEqual({
      success: false,
      error: "Reserved Behavior conversation suffix",
    });
  });
});
