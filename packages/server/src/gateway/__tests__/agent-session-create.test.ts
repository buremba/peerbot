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
