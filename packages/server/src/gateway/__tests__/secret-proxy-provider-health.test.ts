/**
 * End-to-end proof for the proxy-side provider-health contract: the secret
 * proxy marks an org's `inference_providers` row from the upstream HTTP
 * status (429/402 → quota, 401/403 → auth), clears it on the next 2xx, and
 * treats every other status as "no health signal" — never as healthy.
 *
 * The removed gateway suite (worker-response-liveness, "inference-provider
 * health" describe) covered this contract end-to-end for the retired
 * terminal-row mechanism; this is its proxy-side successor. The upstream is
 * a mocked fetch, but the health writes hit a real embedded Postgres, and
 * the org comes from the agent-org resolver (an independent source, like the
 * signed token in prod) — so a request cannot touch another tenant's row.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import * as providerSecrets from "../../lobu/stores/provider-secrets.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { armTurnTimeout } from "../orchestration/turn-liveness.js";
import type { SecretStore } from "../secrets/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

// The org-row credential path keeps the request free of SecretStore/profile
// dependencies (same mock as secret-proxy-org-upstream.test.ts); the health
// mark/clear store functions stay REAL so they write the embedded DB.
const resolveInferenceProviderConfigSpy = spyOn(
  providerSecrets,
  "resolveInferenceProviderConfig"
).mockImplementation(async () => ({
  baseUrl: "https://myzai.example.com/v1",
  apiKey: "org-zai-key",
  custom: true,
}));

// Import AFTER the mock so secret-proxy's transitive imports pick up the stub.
const { SecretProxy } = await import("../proxy/secret-proxy.js");
const { stopDbForGatewayTests } = await import("./helpers/db-setup.js");

afterAll(async () => {
  resolveInferenceProviderConfigSpy.mockRestore();
  await stopDbForGatewayTests();
});

/** Insert a live provider row for an org the way the settings UI would. */
async function seedProvider(
  organizationId: string,
  slug: string,
  status = "active"
): Promise<void> {
  await getDb()`
    INSERT INTO inference_providers
      (organization_id, slug, kind, api_key_ref, capabilities, status)
    VALUES (${organizationId}, ${slug}, 'openai',
            ${`secret://${organizationId}/${slug}`}, '{}'::jsonb, ${status})
  `;
}

async function providerHealth(
  organizationId: string,
  slug: string
): Promise<{ status: string; error_message: string | null }> {
  const rows = await getDb()<
    { status: string; error_message: string | null }[]
  >`
    SELECT status, error_message FROM inference_providers
    WHERE organization_id = ${organizationId} AND slug = ${slug}
  `;
  if (!rows[0]) throw new Error(`provider ${organizationId}/${slug} not found`);
  return rows[0];
}

function makeProxy(callerOrgId: string): InstanceType<typeof SecretProxy> {
  const proxy = new SecretProxy(
    { defaultUpstreamUrl: "https://default.example.com" },
    { get: async () => null } satisfies SecretStore
  );
  proxy.registerUpstream(
    { slug: "zai", upstreamBaseUrl: "https://myzai.example.com/v1" },
    "zai"
  );
  proxy.setAuthProfilesManager({
    // Must not be consulted on the org-only path (fail-closed to the row key).
    getBestProfile: async () => {
      throw new Error("profile lookup must not run on org-only path");
    },
    ensureFreshCredential: async () => undefined,
  } as never);
  // Independent source of the caller's org — prod supplies it from the signed
  // worker token / DB lookup, never from the request body.
  proxy.setAgentOrgResolver(async () => callerOrgId);
  return proxy;
}

/** Drive one proxied chat-completions request through the Hono app. */
async function driveProxiedTurn(proxy: InstanceType<typeof SecretProxy>) {
  return proxy
    .getApp()
    .request("/api/proxy/zai/a/agent-1/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer worker-token-test",
      },
      body: JSON.stringify({ model: "zai/glm-5.2", prompt: "hi" }),
    });
}

/** Swap globalThis.fetch for one upstream response; returns a restorer. */
function mockUpstream(status: number, headers: Record<string, string> = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("secret proxy — inference-provider health writeback", () => {
  // --- Turn-liveness wiring -------------------------------------------------
  // A terminal provider answer must ALSO stop the wedged turn from renewing its
  // own liveness deadline. This half is easy to ship INERT: it only runs when
  // the SIGNED worker token carries a `deploymentName`, and the other tests in
  // this file authenticate with an unsigned placeholder bearer, so they would
  // pass whether or not the wiring exists. These drive a real signed token.

  const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

  function signedWorkerToken(deploymentName: string, organizationId: string) {
    return generateWorkerToken("user-1", `conv-${deploymentName}`, deploymentName, {
      channelId: "chan",
      agentId: "agent-1",
      organizationId,
      platform: "api",
      responseThreadId: "api:chan:thread-1",
      runId: 1,
      messageId: "m-1",
    });
  }

  async function armMarker(deploymentName: string): Promise<void> {
    // `runs` has an FK to `organization`; the marker row needs a real org.
    await getDb()`
      INSERT INTO public.organization (id, name, slug)
      VALUES ('org-1', 'org-1', 'org-1')
      ON CONFLICT (id) DO NOTHING
    `;
    const queue = new RunsQueue();
    await queue.start();
    try {
      await armTurnTimeout(queue, {
        deploymentName,
        messageId: "m-1",
        platform: "api",
        channelId: "chan",
        conversationId: `conv-${deploymentName}`,
        userId: "user-1",
        organizationId: "org-1",
      });
    } finally {
      await queue.stop();
    }
  }

  async function providerFailedFlag(deploymentName: string): Promise<string | null> {
    const rows = (await getDb()`
      SELECT action_input->>'providerFailed' AS flag
      FROM public.runs
      WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
    `) as Array<{ flag: string | null }>;
    return rows[0]?.flag ?? null;
  }

  /** Same as driveProxiedTurn, but authenticating with a real signed token. */
  async function driveSignedTurn(
    proxy: InstanceType<typeof SecretProxy>,
    deploymentName: string
  ) {
    return proxy
      .getApp()
      .request("/api/proxy/zai/a/agent-1/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signedWorkerToken(deploymentName, "org-1")}`,
        },
        body: JSON.stringify({ model: "zai/glm-5.2", prompt: "hi" }),
      });
  }

  test("TL1: a 429 flags the deployment's turn marker so its heartbeat stops extending", async () => {
    await seedProvider("org-1", "zai");
    await armMarker("dep-tl1");
    expect(await providerFailedFlag("dep-tl1")).toBeNull();

    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429, { "retry-after": "60" });
    try {
      expect((await driveSignedTurn(proxy, "dep-tl1")).status).toBe(429);
    } finally {
      restore();
    }
    expect(await providerFailedFlag("dep-tl1")).toBe("true");
  });

  test("TL2: a subsequent 2xx clears the flag so an SDK retry that recovers is not swept", async () => {
    await seedProvider("org-1", "zai");
    await armMarker("dep-tl2");

    const proxy = makeProxy("org-1");
    let restore = mockUpstream(429, { "retry-after": "1" });
    try {
      await driveSignedTurn(proxy, "dep-tl2");
    } finally {
      restore();
    }
    expect(await providerFailedFlag("dep-tl2")).toBe("true");

    restore = mockUpstream(200);
    try {
      expect((await driveSignedTurn(proxy, "dep-tl2")).status).toBe(200);
    } finally {
      restore();
    }
    expect(await providerFailedFlag("dep-tl2")).toBeNull();
  });

  test("an upstream quota rejection (429) marks the provider row error", async () => {
    await seedProvider("org-1", "zai");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429, { "retry-after": "60" });
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(429);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "error",
        error_message: "HTTP 429 (retry-after: 60) — PROVIDER_QUOTA_EXHAUSTED",
      });
    } finally {
      restore();
    }
  });

  test("a rejected credential (401) marks it too, without a horizon", async () => {
    await seedProvider("org-1", "zai");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(401);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(401);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "error",
        error_message: "HTTP 401 — PROVIDER_AUTH",
      });
    } finally {
      restore();
    }
  });

  test("the next successful (2xx) completion clears the error", async () => {
    await seedProvider("org-1", "zai", "error");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(200);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(200);
      expect(await providerHealth("org-1", "zai")).toEqual({
        status: "active",
        error_message: null,
      });
    } finally {
      restore();
    }
  });

  test("a caller-fault status (400) carries no health signal — it does NOT clear", async () => {
    // "No signal" is distinct from "healthy": a bad-request 400 from the same
    // provider must neither mark nor resurrect-clear the row.
    await seedProvider("org-1", "zai", "error");
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(400);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(400);
      expect((await providerHealth("org-1", "zai")).status).toBe("error");
    } finally {
      restore();
    }
  });

  test("the health write is org-scoped: another tenant's same-slug row is untouched", async () => {
    await seedProvider("org-1", "zai");
    await seedProvider("org-2", "zai");
    // Caller identity resolves to org-1 only.
    const proxy = makeProxy("org-1");
    const restore = mockUpstream(429);
    try {
      const res = await driveProxiedTurn(proxy);
      expect(res.status).toBe(429);
      expect((await providerHealth("org-1", "zai")).status).toBe("error");
      expect(await providerHealth("org-2", "zai")).toEqual({
        status: "active",
        error_message: null,
      });
    } finally {
      restore();
    }
  });
});
