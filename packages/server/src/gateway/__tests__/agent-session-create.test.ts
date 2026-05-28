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
 * ownership is always denied. No DB: `RevokedTokenStore.isRevoked` fails open
 * to `false` when no pool is configured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Agent that "exists" in the metadata store; everything else is unknown. */
const EXISTING_AGENT = "agent-existing";

let savedKey: string | undefined;
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
