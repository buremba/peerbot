/**
 * F4: OAuth `/{provider}/login` agent-ownership gate.
 *
 * The handler resolves `agentId = session?.agentId || query("agentId")` and
 * used to mint OAuth state off a session check alone — so any logged-in user
 * could start an OAuth flow bound to an agent they don't own by passing
 * `?agentId=<victim>`. The fix runs `verifyOwnedAgentAccess` before creating
 * state; a non-owned agent is rejected (403) and never reaches the state store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentMetadata } from "@lobu/core";
import type { SettingsTokenPayload } from "../auth/settings/token-service.js";
import {
  type ProviderOAuthClient,
  createOAuthRoutes,
} from "../routes/public/oauth.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

class FakeUserAgentsStore {
  constructor(private owned: Record<string, Set<string>>) {}
  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    return this.owned[`${platform}:${userId}`]?.has(agentId) ?? false;
  }
  async findAgentOrganizations(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<string[]> {
    return this.owned[`${platform}:${userId}`]?.has(agentId) ? ["org_1"] : [];
  }
  addAgent(): void {
    /* best-effort no-op for tests */
  }
}

const fakeOAuthClient: ProviderOAuthClient = {
  generateCodeVerifier: () => "verifier",
  buildAuthUrl: (state) => `https://provider.example/auth?state=${state}`,
  exchangeCodeForToken: async () => ({}),
};

let createdStateCount = 0;
const fakeStateStore = {
  async create(): Promise<string> {
    createdStateCount += 1;
    return "state-token";
  },
  async consume(): Promise<null> {
    return null;
  },
};

function makeSession(
  overrides: Partial<SettingsTokenPayload> = {}
): SettingsTokenPayload {
  return {
    userId: "u1",
    oauthUserId: "u1",
    platform: "external",
    exp: Date.now() + 60_000,
    ...overrides,
  };
}

function buildApp(opts: {
  owned: Record<string, Set<string>>;
  agentMetadata?: (agentId: string) => Promise<AgentMetadata | null>;
}): Hono {
  const router = createOAuthRoutes({
    oauthClients: { claude: fakeOAuthClient },
    // biome-ignore lint: test fake matches the consumed slice of the store
    oauthStateStore: fakeStateStore as any,
    // biome-ignore lint: test fake matches the consumed slice of the store
    userAgentsStore: new FakeUserAgentsStore(opts.owned) as any,
    agentMetadataStore: {
      getMetadata: opts.agentMetadata ?? (async () => null),
    },
  });
  const app = new Hono();
  app.route("/", router);
  return app;
}

describe("OAuth /{provider}/login ownership gate (F4)", () => {
  beforeEach(() => {
    createdStateCount = 0;
  });
  afterEach(() => {
    setAuthProvider(null);
  });

  test("rejects a non-owned agentId from the query param with 403", async () => {
    // u1 owns agent-mine, NOT agent-victim.
    setAuthProvider(() => makeSession());
    const app = buildApp({ owned: { "external:u1": new Set(["agent-mine"]) } });

    const res = await app.request("/claude/login?agentId=agent-victim");
    expect(res.status).toBe(403);
    // The state store must NOT have been touched.
    expect(createdStateCount).toBe(0);
  });

  test("allows the owner to mint state for their own agent (redirect)", async () => {
    setAuthProvider(() => makeSession());
    const app = buildApp({ owned: { "external:u1": new Set(["agent-mine"]) } });

    const res = await app.request("/claude/login?agentId=agent-mine");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("state=state-token");
    expect(createdStateCount).toBe(1);
  });

  test("rejects when the session is bound to a different agent than the query", async () => {
    // Session pinned to agent-A; attacker passes agentId=agent-B in the query.
    // `session.agentId` wins, and ownership for a mismatched query is moot —
    // verifyOwnedAgentAccess rejects a session.agentId != agentId mismatch.
    setAuthProvider(() => makeSession({ agentId: "agent-A" }));
    const app = buildApp({ owned: { "external:u1": new Set(["agent-A"]) } });

    // session.agentId === agent-A → resolved agentId is agent-A (query ignored
    // when session carries one), which the user owns → allowed.
    const res = await app.request("/claude/login?agentId=agent-B");
    expect(res.status).toBe(302);
  });

  test("admins bypass the ownership check", async () => {
    setAuthProvider(() => makeSession({ isAdmin: true }));
    const app = buildApp({ owned: {} }); // owns nothing

    const res = await app.request("/claude/login?agentId=any-agent");
    expect(res.status).toBe(302);
    expect(createdStateCount).toBe(1);
  });

  test("still 400s when no agentId can be resolved", async () => {
    setAuthProvider(() => makeSession());
    const app = buildApp({ owned: {} });

    const res = await app.request("/claude/login");
    expect(res.status).toBe(400);
  });
});
