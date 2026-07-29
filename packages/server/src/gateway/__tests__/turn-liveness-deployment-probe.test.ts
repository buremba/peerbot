/**
 * `hasLiveTurnForDeployment` against real `runs` rows.
 *
 * The recycle paths consult this before tearing a worker down, and the
 * dispatch-gate suite injects a stub for it — so without this file the actual
 * SQL is executed by nothing, and inverting its deadline predicate, dropping
 * the deployment filter, or breaking the delivery-receipt join would leave
 * every suite green while the recycle either SIGTERMs live turns or deadlocks
 * queued ones.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { hasLiveTurnForDeployment } from "../orchestration/turn-liveness.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";
const DEPLOYMENT = "deploy-probe";

/** Insert a turn-liveness marker the way `armTurnTimeout` does. */
async function seedMarker(params: {
  deploymentName?: string;
  messageId?: string;
  /** Seconds from now the deadline lapses; negative = already lapsed. */
  runAtOffsetSec?: number;
  status?: string;
  runType?: string;
  queueName?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES (
      ${params.runType ?? "internal"},
      ${params.queueName ?? TURN_TIMEOUT_QUEUE},
      ${params.status ?? "pending"},
      now() + make_interval(secs => ${params.runAtOffsetSec ?? 60}),
      ${sql.json({
        deploymentName: params.deploymentName ?? DEPLOYMENT,
        messageId: params.messageId ?? "m-1",
      })}
    )
  `;
}

/** Insert a `thread_message_*` job row the way the consumer's enqueue does. */
async function seedThreadJob(params: {
  deploymentName?: string;
  messageId?: string;
  status?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES (
      'chat_message',
      ${`thread_message_${params.deploymentName ?? DEPLOYMENT}`},
      ${params.status ?? "pending"},
      now(),
      ${sql.json({ messageId: params.messageId ?? "m-1" })}
    )
  `;
}

/** Marker + completed job row: a turn the worker has actually received. */
async function seedDeliveredTurn(
  messageId: string,
  markerParams: Parameters<typeof seedMarker>[0] = {}
): Promise<void> {
  await seedMarker({ messageId, ...markerParams });
  await seedThreadJob({
    messageId,
    status: "completed",
    deploymentName: markerParams.deploymentName,
  });
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("hasLiveTurnForDeployment", () => {
  test("no markers means nothing is in flight", async () => {
    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a delivered turn's live marker blocks a recycle", async () => {
    await seedDeliveredTurn("m-1", { runAtOffsetSec: 60 });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("finds a live turn regardless of which message armed it", async () => {
    // Deployment-scoped, unlike hasLiveTurnForMessage: the recycle must not
    // interrupt ANY turn on this worker, not just the current message's.
    await seedDeliveredTurn("some-other-message");

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("a lapsed marker does not block a recycle, even when delivered", async () => {
    // 60s with no worker-driven signal means the worker is silent or dead; the
    // sweep will terminalize that turn anyway. Treating it as live would let a
    // hung worker block renewal forever. Delivery receipt seeded so the lapse
    // is the only thing this test discriminates on.
    await seedDeliveredTurn("m-1", { runAtOffsetSec: -30 });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("another deployment's live turn is not ours", async () => {
    // Without the deploymentName predicate, any busy conversation anywhere in
    // the fleet would block every recycle.
    await seedDeliveredTurn("m-1", { deploymentName: "deploy-somebody-else" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a completed turn is not in flight", async () => {
    await seedDeliveredTurn("m-1", { status: "completed" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a non-turn-timeout run is not a turn marker", async () => {
    // The `runs` table carries every queued job; only this queue's rows are
    // turn-liveness markers.
    await seedDeliveredTurn("m-1", { queueName: "internal:something_else" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a non-internal run_type is not a turn marker", async () => {
    // `armTurnTimeout` writes markers on an `internal:` queue, which
    // classifyQueue maps to run_type 'internal'. The predicate is what keeps
    // this query on `runs_lobu_claim_idx`'s partial index, so dropping it would
    // both widen the probe and turn an index probe into a scan of the 30-day
    // retention.
    await seedDeliveredTurn("m-1", { runType: "chat_message" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });
});

describe("hasLiveTurnForDeployment delivery receipt", () => {
  test("REGRESSION: an armed-but-still-queued turn is not a RUNNING turn", async () => {
    // A turn's marker is armed at dispatch, BEFORE its thread_message job is
    // delivered. The dispatch gate holds one such claimed job when it probes,
    // and other turns may sit queued behind it. Counting those markers as
    // live turns would let two queued turns defer each other forever — the
    // deadlock the delivery-receipt requirement exists to prevent.
    await seedMarker({ messageId: "m-queued" });
    await seedThreadJob({ messageId: "m-queued", status: "pending" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a claimed-but-undelivered job is not a running turn either", async () => {
    // The gate's own claimed job is `status='claimed'` while the handler runs.
    await seedMarker({ messageId: "m-claimed" });
    await seedThreadJob({ messageId: "m-claimed", status: "claimed" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a delivered turn (job row completed) IS a running turn", async () => {
    // Delivery receipt completes the thread_message run; from then until the
    // worker's terminal reply, the marker is the record of a turn the worker
    // actually holds — exactly what a teardown would interrupt.
    await seedMarker({ messageId: "m-delivered" });
    await seedThreadJob({ messageId: "m-delivered", status: "completed" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("REGRESSION: an SSE-reconnect replay row does not hide a running turn", async () => {
    // registerWorker replays the durable agent_run_input of every
    // non-terminalized turn when a worker reconnects — including a turn that is
    // actively RUNNING on that worker. The replay creates a fresh pending
    // thread_message row for the SAME messageId. Reading "a pending row
    // exists" as "never delivered" would let a stale-worker recycle SIGTERM
    // the active worker mid-turn; the completed delivery receipt must win.
    await seedMarker({ messageId: "m-replayed" });
    await seedThreadJob({ messageId: "m-replayed", status: "completed" });
    await seedThreadJob({ messageId: "m-replayed", status: "pending" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("another deployment's queued job does not shadow OUR delivered turn", async () => {
    // Both joins must be scoped to this deployment's queue: a queued job
    // elsewhere reusing the same platform messageId (Telegram ids are
    // per-chat) must not hide a genuinely running turn here.
    await seedMarker({ messageId: "m-shared" });
    await seedThreadJob({ messageId: "m-shared", status: "completed" });
    await seedThreadJob({
      deploymentName: "deploy-somebody-else",
      messageId: "m-shared",
      status: "pending",
    });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("another deployment's delivery receipt is not OURS", async () => {
    // The completed-row join is deployment-scoped too: a delivered turn on a
    // different worker reusing the messageId must not make OUR still-queued
    // turn look delivered.
    await seedMarker({ messageId: "m-foreign" });
    await seedThreadJob({
      deploymentName: "deploy-somebody-else",
      messageId: "m-foreign",
      status: "completed",
    });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });
});
