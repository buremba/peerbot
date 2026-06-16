/**
 * The embedded panel's SSE stream can't send Authorization (EventSource), so it
 * authenticates with a `?token=` ticket from /api/sse-ticket. The agent routes'
 * ownership gate (`requireAgentOwnership` → `verifySettingsSessionOrToken(c,
 * "token")`) must accept that ticket exactly like a first-party web session.
 *
 * This drives the REAL `createAgentApi` route with a real encrypted ticket and
 * real ownership stubs: an owner-matching ticket gets PAST the 403 gate; no
 * ticket is denied. (We assert the auth boundary, not the downstream session
 * creation, which uses minimal stubs.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "@lobu/core";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AGENT = "agent-owned";
const USER = "user-owner";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
  setAuthProvider(null); // force the settings-session/ticket path, not an injected provider
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  setAuthProvider(null);
});

// Agent owned by (external, USER) — the shape an owletto web user / SSE ticket
// carries. `findAgentOrganizations` is the authoritative resolver the ownership
// check consults.
function makeApp() {
  return createAgentApi({
    queueProducer: {} as never,
    sessionManager: {} as never,
    sseManager: {} as never,
    publicGatewayUrl: "http://localhost:8787",
    userAgentsStore: {
      async ownsAgent(platform: string, userId: string, agentId: string) {
        return platform === "external" && userId === USER && agentId === AGENT;
      },
      async addAgent() {},
      async findAgentOrganizations(
        platform: string,
        userId: string,
        agentId: string,
      ) {
        return platform === "external" && userId === USER && agentId === AGENT
          ? ["test-org"]
          : [];
      },
    } as never,
    agentMetadataStore: {
      async getMetadata() {
        return { owner: { platform: "external", userId: USER } };
      },
    } as never,
  });
}

// A ticket of the exact shape GET /api/sse-ticket mints.
function sseTicket(userId: string): string {
  return encrypt(
    JSON.stringify({ userId, platform: "external", exp: Date.now() + 60_000 }),
  );
}

async function createSession(query: string): Promise<Response> {
  return makeApp().request(`/api/v1/agents${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: AGENT }),
  });
}

describe("agent route auth via SSE ticket (?token=)", () => {
  test("an owner-matching ticket passes BOTH the outer auth gate and ownership", async () => {
    const res = await createSession(
      `?token=${encodeURIComponent(sseTicket(USER))}`,
    );
    // Past the outer middleware's 401 AND requireAgentOwnership's 403 → the
    // ticket fully authenticated. (Downstream session creation runs on minimal
    // stubs, so the exact post-auth status doesn't matter.)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("a valid ticket for a NON-owner authenticates but is denied ownership (403)", async () => {
    const res = await createSession(
      `?token=${encodeURIComponent(sseTicket("someone-else"))}`,
    );
    expect(res.status).toBe(403);
  });

  test("no ticket and no Authorization header is rejected at the outer gate (401)", async () => {
    const res = await createSession("");
    expect(res.status).toBe(401);
  });

  test("a tampered/garbage ticket does not authenticate (401)", async () => {
    const res = await createSession("?token=not-a-real-encrypted-ticket");
    expect(res.status).toBe(401);
  });
});
