/**
 * Integration tests for the worker-token refresh endpoint
 * (`POST /worker/token/refresh`) against a real Postgres (embedded PG18 in CI).
 *
 * The endpoint mints a fresh 2h worker token from a currently-valid one, gated
 * on deployment-liveness: a fresh token is issued ONLY while an in-flight
 * turn-timeout marker exists for the token's deployment (the cross-pod-
 * authoritative liveness signal in shared `public.runs`). When the work goes
 * terminal the marker is gone and refresh is DENIED — that denial is the
 * revocation property (a leaked token's chain ends with its work).
 *
 * The liveness gate itself (across every terminalization path) is unit-tested
 * in turn-liveness.test.ts; this file is the end-to-end route surface: auth,
 * the runId-eligibility gate, the liveness gate, and the minted-token claims.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  armTurnTimeout,
  failTurnsForDeployment,
} from "../orchestration/turn-liveness.js";
import { WorkerGateway } from "../gateway/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

let queue: RunsQueue;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await resetTestDatabase();
  // The runs FK requires the organization to exist before arming a marker.
  await seedAgentRow("agent-1", { organizationId: "org-1" });
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  await queue.stop();
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

/** Construct a WorkerGateway with stub deps — the refresh route only touches
 *  the DB (liveness gate + revoked-token store) and the token codec, none of
 *  the session-context / MCP collaborators. */
function makeGateway(): WorkerGateway {
  return new WorkerGateway(
    queue as any,
    "https://gateway.example.com",
    { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
    {
      getSessionContext: async () => ({
        agentInstructions: "",
        platformInstructions: "",
        networkInstructions: "",
        skillsInstructions: "",
        mcpStatus: [],
      }),
    } as any
  );
}

async function postRefresh(token: string) {
  return makeGateway()
    .getApp()
    .request("/token/refresh", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "gateway.example.com",
      },
    });
}

const DEPLOYMENT = "lobu-worker-agent-1";

function mintToken(opts: { runId?: number }): string {
  return generateWorkerToken("user-1", "conv-1", DEPLOYMENT, {
    channelId: "chan-1",
    agentId: "agent-1",
    organizationId: "org-1",
    connectionId: "connection-1",
    source: "watcher-run",
    runId: opts.runId,
  });
}

function armLiveTurn(): Promise<void> {
  return armTurnTimeout(queue, {
    messageId: "m1",
    channelId: "chan-1",
    conversationId: "conv-1",
    userId: "user-1",
    platform: "api",
    deploymentName: DEPLOYMENT,
    organizationId: "org-1",
  });
}

describe("POST /worker/token/refresh", () => {
  test("mints a fresh token while the deployment has a live turn", async () => {
    await armLiveTurn();
    const original = mintToken({ runId: 42 });

    const res = await postRefresh(original);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe(original);

    // Fresh token verifies and preserves the claims (incl. runId, connectionId,
    // source — the superset the per-run token carries).
    const data = verifyWorkerToken(body.token);
    expect(data).not.toBeNull();
    expect(data!.runId).toBe(42);
    expect(data!.connectionId).toBe("connection-1");
    expect(data!.source).toBe("watcher-run");
    expect(data!.deploymentName).toBe(DEPLOYMENT);
    expect(data!.organizationId).toBe("org-1");
  });

  test("REVOCATION: denied (403) once the deployment has no live turn", async () => {
    // No armed turn → the deployment is not live → refresh must be refused.
    const original = mintToken({ runId: 42 });
    const res = await postRefresh(original);
    expect(res.status).toBe(403);
  });

  test("REVOCATION: a token that was refreshable becomes non-refreshable after the turn terminalizes", async () => {
    await armLiveTurn();
    const original = mintToken({ runId: 42 });

    // First refresh succeeds while live.
    expect((await postRefresh(original)).status).toBe(200);

    // The worker dies / replies → marker discharged. Use the fast path to
    // simulate terminalization, then refresh must be denied.
    await failTurnsForDeployment(DEPLOYMENT, "worker died");

    const res = await postRefresh(original);
    expect(res.status).toBe(403);
  });

  test("denied (403) for a token with no runId (legacy direct-enqueue, no marker to gate on)", async () => {
    await armLiveTurn();
    const noRunId = mintToken({}); // runId omitted
    const res = await postRefresh(noRunId);
    expect(res.status).toBe(403);
  });

  test("rejected (401) for a malformed / unverifiable token", async () => {
    await armLiveTurn();
    const res = await postRefresh("not-a-real-token");
    expect(res.status).toBe(401);
  });
});
