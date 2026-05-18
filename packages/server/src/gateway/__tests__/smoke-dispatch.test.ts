/**
 * Unit tests for the internal smoke-dispatch endpoint.
 *
 * Covers the three-layer auth contract:
 *   1. SMOKE_TEST_TOKEN bearer (constant-time compare)
 *   2. Ingress-bypass: any x-forwarded-* header → 403
 *   3. Server-pinned smoke namespace from SMOKE_TEST_AGENT_ID /
 *      SMOKE_TEST_ORG_ID env (caller-supplied agentId/organizationId
 *      are silently ignored)
 *
 * Plus input validation (conversationId required + prefix-checked),
 * runs INSERT happy path, and idempotency.
 *
 * The end-to-end "real worker actually processes the synthetic run"
 * path is gated by the Helm post-upgrade smoke Job at deploy time, not
 * by these unit tests.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { createSmokeRoutes } from "../routes/internal/smoke.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const SMOKE_TOKEN = "test-smoke-token-deadbeef-cafef00d-feedface";
const SMOKE_AGENT_ID = "smoke-test";
const SMOKE_ORG_ID = "smoke-org";

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv() {
  savedEnv.SMOKE_TEST_TOKEN = process.env.SMOKE_TEST_TOKEN;
  savedEnv.SMOKE_TEST_AGENT_ID = process.env.SMOKE_TEST_AGENT_ID;
  savedEnv.SMOKE_TEST_ORG_ID = process.env.SMOKE_TEST_ORG_ID;
  savedEnv.SMOKE_TEST_ALLOWED_HOST = process.env.SMOKE_TEST_ALLOWED_HOST;
}

function restoreEnv() {
  for (const k of Object.keys(savedEnv)) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  snapshotEnv();
  process.env.SMOKE_TEST_TOKEN = SMOKE_TOKEN;
  process.env.SMOKE_TEST_AGENT_ID = SMOKE_AGENT_ID;
  process.env.SMOKE_TEST_ORG_ID = SMOKE_ORG_ID;
});

afterEach(() => {
  restoreEnv();
});

function mountSmoke(): Hono {
  const app = new Hono();
  app.route("/api/internal/smoke", createSmokeRoutes());
  return app;
}

async function dispatch(
  app: Hono,
  body: Record<string, unknown>,
  token: string | null = SMOKE_TOKEN,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request("/api/internal/smoke/dispatch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("smoke dispatch auth", () => {
  test("rejects missing bearer", async () => {
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" }, null);
    expect(res.status).toBe(401);
  });

  test("rejects wrong-length token", async () => {
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-x" },
      "short"
    );
    expect(res.status).toBe(401);
  });

  test("rejects same-length but wrong token", async () => {
    const wrong = SMOKE_TOKEN.slice(0, -1) + "X";
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" }, wrong);
    expect(res.status).toBe(401);
  });

  test("503 when SMOKE_TEST_TOKEN unset", async () => {
    delete process.env.SMOKE_TEST_TOKEN;
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" });
    expect(res.status).toBe(503);
  });

  test("503 when SMOKE_TEST_TOKEN empty string", async () => {
    process.env.SMOKE_TEST_TOKEN = "";
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" });
    expect(res.status).toBe(503);
  });

  test("503 when SMOKE_TEST_AGENT_ID unset", async () => {
    delete process.env.SMOKE_TEST_AGENT_ID;
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" });
    expect(res.status).toBe(503);
  });

  test("503 when SMOKE_TEST_ORG_ID unset", async () => {
    delete process.env.SMOKE_TEST_ORG_ID;
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-x" });
    expect(res.status).toBe(503);
  });
});

describe("smoke dispatch Host allowlist", () => {
  test("accepts request when SMOKE_TEST_ALLOWED_HOST unset (no Host check)", async () => {
    delete process.env.SMOKE_TEST_ALLOWED_HOST;
    const res = await dispatch(mountSmoke(), { conversationId: "smoke-no-host" });
    expect(res.status).toBe(200);
  });

  test("rejects request whose Host does not match SMOKE_TEST_ALLOWED_HOST", async () => {
    process.env.SMOKE_TEST_ALLOWED_HOST = "release-name-lobu-app";
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-bad-host" },
      SMOKE_TOKEN,
      { host: "app.lobu.ai" }
    );
    expect(res.status).toBe(403);
  });

  test("accepts request whose Host matches SMOKE_TEST_ALLOWED_HOST exactly", async () => {
    process.env.SMOKE_TEST_ALLOWED_HOST = "release-name-lobu-app";
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-good-host" },
      SMOKE_TOKEN,
      { host: "release-name-lobu-app" }
    );
    expect(res.status).toBe(200);
  });

  test("accepts request whose Host carries a port suffix", async () => {
    process.env.SMOKE_TEST_ALLOWED_HOST = "release-name-lobu-app";
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-port-host" },
      SMOKE_TOKEN,
      { host: "release-name-lobu-app:8787" }
    );
    expect(res.status).toBe(200);
  });

  test("accepts request whose Host carries the cluster.local FQDN suffix", async () => {
    process.env.SMOKE_TEST_ALLOWED_HOST = "release-name-lobu-app";
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-fqdn-host" },
      SMOKE_TOKEN,
      { host: "release-name-lobu-app.my-ns.svc.cluster.local" }
    );
    expect(res.status).toBe(200);
  });
});

describe("smoke dispatch ingress-bypass defense", () => {
  test("rejects request with x-forwarded-for", async () => {
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-ingress" },
      SMOKE_TOKEN,
      { "x-forwarded-for": "203.0.113.1" }
    );
    expect(res.status).toBe(403);
  });

  test("rejects request with forwarded header", async () => {
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-ingress" },
      SMOKE_TOKEN,
      { forwarded: "for=203.0.113.1" }
    );
    expect(res.status).toBe(403);
  });

  test("rejects request with x-real-ip", async () => {
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-ingress" },
      SMOKE_TOKEN,
      { "x-real-ip": "203.0.113.1" }
    );
    expect(res.status).toBe(403);
  });

  test("rejects request with x-forwarded-host", async () => {
    const res = await dispatch(
      mountSmoke(),
      { conversationId: "smoke-ingress" },
      SMOKE_TOKEN,
      { "x-forwarded-host": "evil.example.com" }
    );
    expect(res.status).toBe(403);
  });
});

describe("smoke dispatch input validation", () => {
  test("rejects missing conversationId", async () => {
    const res = await dispatch(mountSmoke(), {});
    expect(res.status).toBe(400);
  });

  test("rejects conversationId without smoke- prefix", async () => {
    const res = await dispatch(mountSmoke(), {
      conversationId: "production-conv-id",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("smoke-");
  });

  test("rejects invalid JSON", async () => {
    const res = await mountSmoke().request("/api/internal/smoke/dispatch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SMOKE_TOKEN}`,
        "content-type": "application/json",
      },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("smoke dispatch insert + namespace pinning", () => {
  test("inserts chat_message run with env-pinned agentId/organizationId", async () => {
    const res = await dispatch(mountSmoke(), {
      conversationId: "smoke-release-1",
      messageText: "hello",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: number; idempotencyKey: string };
    expect(typeof body.runId).toBe("number");
    expect(body.runId).toBeGreaterThan(0);
    expect(body.idempotencyKey).toBe("smoke:smoke-release-1");

    const sql = getDb();
    const rows = await sql<{
      run_type: string;
      queue_name: string;
      status: string;
      idempotency_key: string;
      action_input: Record<string, unknown>;
    }>`
      SELECT run_type, queue_name, status, idempotency_key, action_input
      FROM public.runs
      WHERE id = ${body.runId}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.run_type).toBe("chat_message");
    expect(row.queue_name).toBe("messages");
    expect(row.status).toBe("pending");
    expect(row.idempotency_key).toBe("smoke:smoke-release-1");
    expect(row.action_input.agentId).toBe(SMOKE_AGENT_ID);
    expect(row.action_input.organizationId).toBe(SMOKE_ORG_ID);
    expect(row.action_input.conversationId).toBe("smoke-release-1");
    expect(row.action_input.platform).toBe("smoke");
    expect(row.action_input.messageText).toBe("hello");
  });

  test("caller-supplied agentId/organizationId in body are silently ignored", async () => {
    // A leaked SMOKE_TEST_TOKEN trying to target a real tenant — the
    // body fields must be ignored, and the env-pinned smoke namespace
    // is the one that lands in the runs row.
    const res = await mountSmoke().request("/api/internal/smoke/dispatch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SMOKE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "real-tenant-agent",
        organizationId: "real-tenant-org",
        conversationId: "smoke-attempt",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: number };
    const sql = getDb();
    const rows = await sql<{ action_input: Record<string, unknown> }>`
      SELECT action_input FROM public.runs WHERE id = ${body.runId}
    `;
    expect(rows[0]!.action_input.agentId).toBe(SMOKE_AGENT_ID);
    expect(rows[0]!.action_input.organizationId).toBe(SMOKE_ORG_ID);
  });

  test("default messageText when omitted", async () => {
    const res = await dispatch(mountSmoke(), {
      conversationId: "smoke-default-msg",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: number };
    const sql = getDb();
    const rows = await sql<{ action_input: Record<string, unknown> }>`
      SELECT action_input FROM public.runs WHERE id = ${body.runId}
    `;
    expect(rows[0]!.action_input.messageText).toBe("smoke-test ping");
  });

  test("idempotent: second dispatch with same conv returns same runId", async () => {
    const first = await dispatch(mountSmoke(), {
      conversationId: "smoke-idem",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { runId: number };

    const second = await dispatch(mountSmoke(), {
      conversationId: "smoke-idem",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { runId: number };
    expect(secondBody.runId).toBe(firstBody.runId);

    const sql = getDb();
    const rows = await sql`
      SELECT COUNT(*)::int AS cnt FROM public.runs
      WHERE idempotency_key = 'smoke:smoke-idem'
    `;
    expect((rows[0] as { cnt: number }).cnt).toBe(1);
  });
});
