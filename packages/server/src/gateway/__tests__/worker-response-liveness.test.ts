/**
 * End-to-end tests for the worker-response liveness signals (#12 / #14) against
 * a real Postgres (embedded PG18 in CI). Drives the gateway's
 * `POST /worker/response` handler the way a real worker subprocess does and
 * asserts the two liveness clocks it must refresh:
 *
 *  - #14: a 20s `status_update` (NO `received` flag) must push the turn-liveness
 *    marker's `run_at` deadline forward. Before the fix only the 30s SSE-ping
 *    ACK extended it, so a live worker emitting status updates every 20s could
 *    still lapse the 60s deadline on ~2 missed ping ACKs and be falsely failed.
 *
 *  - #12: every worker-driven response must refresh the DEPLOYMENT manager's
 *    idle clock (`updateDeploymentActivity`), not just the connection manager's
 *    stale-SSE clock — otherwise the idle reaper scales a long-running worker to
 *    0 mid-turn. Asserted via a stub tracker injected with
 *    `setDeploymentActivityTracker`.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { armTurnTimeout } from "../orchestration/turn-liveness.js";
import { WorkerGateway } from "../gateway/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";
const DEPLOYMENT = "lobu-worker-agent-1";

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

function mintToken(): string {
  return generateWorkerToken("user-1", "conv-1", DEPLOYMENT, {
    channelId: "chan-1",
    agentId: "agent-1",
    organizationId: "org-1",
    connectionId: "connection-1",
    source: "watcher-run",
    runId: 1,
    messageId: "m1",
  });
}

function armLiveTurn(messageId = "m1"): Promise<void> {
  return armTurnTimeout(queue, {
    messageId,
    channelId: "chan-1",
    conversationId: "conv-1",
    userId: "user-1",
    platform: "api",
    deploymentName: DEPLOYMENT,
    organizationId: "org-1",
  });
}

/** Post a body to `/worker/response` through the real Hono handler. The gateway
 *  is shut down in a finally so its timers/intervals don't leak across tests. */
async function postWorkerResponse(
  body: unknown,
  opts?: { tracker?: { updateDeploymentActivity: (d: string) => Promise<void> } }
): Promise<Response> {
  const gateway = makeGateway();
  if (opts?.tracker) gateway.setDeploymentActivityTracker(opts.tracker);
  try {
    return await gateway.getApp().request("/response", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintToken()}`,
        host: "gateway.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } finally {
    gateway.shutdown();
  }
}

/** Read the marker's `run_at` (epoch ms) for the live turn, or null if gone. */
async function markerRunAtMs(): Promise<number | null> {
  const rows = await getDb()<{ run_at: Date }>`
    SELECT run_at FROM public.runs
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
      AND action_input->>'deploymentName' = ${DEPLOYMENT}
      AND action_input->>'messageId' = 'm1'
    LIMIT 1`;
  return rows[0] ? new Date(rows[0].run_at).getTime() : null;
}

/** Force the marker's deadline to a known PAST instant so any extend is
 *  observable as a forward jump (and so the marker counts as lapsed). */
async function expireMarker(): Promise<number> {
  await getDb()`
    UPDATE public.runs SET run_at = now() - interval '5 minutes'
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}`;
  const at = await markerRunAtMs();
  if (at === null) throw new Error("marker missing after expire");
  return at;
}

describe("POST /worker/response — turn-liveness deadline (#14)", () => {
  test("a 20s status_update (no `received`) extends the deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();
    expect(lapsedAt).toBeLessThan(Date.now()); // sanity: deadline is in the past

    // A status_update response carries `statusUpdate` and NO `received` flag —
    // exactly what GatewayIntegration.sendStatusUpdate emits every 20s.
    const res = await postWorkerResponse({
      messageId: "m1",
      conversationId: "conv-1",
      statusUpdate: { elapsedSeconds: 40, state: "working" },
    });
    expect(res.status).toBe(200);

    // The extend is best-effort/fire-and-forget; poll briefly for the UPDATE to
    // land rather than racing it.
    let after: number | null = null;
    for (let i = 0; i < 50; i++) {
      after = await markerRunAtMs();
      if (after !== null && after > lapsedAt + 1000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(after).not.toBeNull();
    // The deadline must have jumped forward into the FUTURE — before the fix a
    // status_update never extended, so run_at would stay at `lapsedAt` (past).
    expect(after!).toBeGreaterThan(Date.now());
    expect(after!).toBeGreaterThan(lapsedAt);
  });

  test("a delivery/heartbeat ACK (`received`) still extends the deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();

    const res = await postWorkerResponse({ received: true, heartbeat: true });
    expect(res.status).toBe(200);

    let after: number | null = null;
    for (let i = 0; i < 50; i++) {
      after = await markerRunAtMs();
      if (after !== null && after > lapsedAt + 1000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(after!).toBeGreaterThan(Date.now());
  });
});

describe("POST /worker/response — deployment idle clock (#12)", () => {
  test("a status_update refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (d: string) => {
        touched.push(d);
      },
    };

    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        statusUpdate: { elapsedSeconds: 40, state: "working" },
      },
      { tracker }
    );
    expect(res.status).toBe(200);

    // The handler awaits nothing on the tracker (fire-and-forget); give the
    // microtask a tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(touched).toContain(DEPLOYMENT);
  });

  test("a delivery ACK also refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (d: string) => {
        touched.push(d);
      },
    };

    const res = await postWorkerResponse(
      { received: true, heartbeat: true },
      { tracker }
    );
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 20));
    expect(touched).toContain(DEPLOYMENT);
  });
});
