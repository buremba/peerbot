/**
 * Integration tests for turn-liveness (#946) against a real Postgres (PGlite in
 * CI). Exercises the durable election marker end to end: arm, discharge,
 * fast-path failure, the first-writer-wins election (failTurnIfPending),
 * atomic terminal-reply commit, the deadline sweep + exactly-once, and the
 * globally-unique (deploymentName:messageId) marker key.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { getDb } from "../../db/client.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  armTurnTimeout,
  commitTerminalReply,
  extendTurnDeadlines,
  failTurnIfPending,
  failTurnsForDeployment,
  sweepExpiredTurns,
  type TurnRouting,
} from "../orchestration/turn-liveness.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

let queue: RunsQueue;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  await queue.stop();
});

function routing(deploymentName: string, messageId: string): TurnRouting {
  return {
    messageId,
    channelId: "chan",
    conversationId: `conv-${deploymentName}`,
    userId: "user-1",
    platform: "api",
    deploymentName,
  };
}

async function markerCount(deploymentName?: string): Promise<number> {
  const sql = getDb();
  const rows = deploymentName
    ? await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM public.runs
        WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
          AND action_input->>'deploymentName' = ${deploymentName}`
    : await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM public.runs
        WHERE queue_name = ${TURN_TIMEOUT_QUEUE}`;
  return Number(rows[0]?.n ?? 0);
}

async function errorRowCount(): Promise<number> {
  const rows = await getDb()<{ n: number }>`
    SELECT count(*)::int AS n FROM public.runs
    WHERE queue_name = 'thread_response' AND action_input->>'error' IS NOT NULL`;
  return Number(rows[0]?.n ?? 0);
}

async function threadResponseCount(): Promise<number> {
  const rows = await getDb()<{ n: number }>`
    SELECT count(*)::int AS n FROM public.runs WHERE queue_name = 'thread_response'`;
  return Number(rows[0]?.n ?? 0);
}

async function expireAllMarkers(): Promise<void> {
  await getDb()`
    UPDATE public.runs SET run_at = now() - interval '1 minute'
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}`;
}

function reply(deploymentName: string, messageId: string) {
  return {
    messageId,
    conversationId: `conv-${deploymentName}`,
    platform: "api",
    teamId: "api",
    processedMessageIds: [messageId],
    timestamp: Date.now(),
  };
}

describe("turn-liveness", () => {
  test("arm then discharge: a real reply leaves no marker and no error", async () => {
    await armTurnTimeout(queue, routing("dep-1", "m1"));
    expect(await markerCount("dep-1")).toBe(1);

    // A real terminal reply discharges the marker via the production path
    // (commitTerminalReply atomically deletes the marker + inserts the reply).
    await commitTerminalReply("dep-1", ["m1"], reply("dep-1", "m1"), null);
    expect(await markerCount("dep-1")).toBe(0);
    expect(await errorRowCount()).toBe(0);
  });

  test("fast path fails all in-flight turns of a dead deployment, exactly once", async () => {
    await armTurnTimeout(queue, routing("dep-2", "a"));
    await armTurnTimeout(queue, routing("dep-2", "b"));

    expect(await failTurnsForDeployment("dep-2", "worker died")).toBe(2);
    expect(await markerCount("dep-2")).toBe(0);
    expect(await errorRowCount()).toBe(2);

    // Re-running emits nothing (markers already gone) — exactly-once.
    expect(await failTurnsForDeployment("dep-2", "worker died")).toBe(0);
    expect(await errorRowCount()).toBe(2);
  });

  test("failTurnIfPending emits once when the turn is still owed", async () => {
    await armTurnTimeout(queue, routing("dep-3", "m"));

    expect(await failTurnIfPending("dep-3", "m", "startup failed")).toBe(true);
    expect(await errorRowCount()).toBe(1);

    // Marker is gone — a second call must not double-signal.
    expect(await failTurnIfPending("dep-3", "m", "startup failed")).toBe(false);
    expect(await errorRowCount()).toBe(1);
  });

  test("failTurnIfPending does NOT double-signal when a worker already replied", async () => {
    await armTurnTimeout(queue, routing("dep-4", "m"));
    // Worker raced a real terminal reply → marker discharged via the production
    // commitTerminalReply path.
    await commitTerminalReply("dep-4", ["m"], reply("dep-4", "m"), null);

    expect(await failTurnIfPending("dep-4", "m", "startup failed")).toBe(false);
    // commitTerminalReply emitted a (non-error) reply; no error row.
    expect(await errorRowCount()).toBe(0);
  });

  test("commitTerminalReply atomically discharges the marker and enqueues the reply", async () => {
    await armTurnTimeout(queue, routing("dep-5", "m"));

    const emitted = await commitTerminalReply("dep-5", ["m"], reply("dep-5", "m"), null);

    expect(emitted).toBe(true);
    expect(await markerCount("dep-5")).toBe(0);
    expect(await threadResponseCount()).toBe(1);
    expect(await errorRowCount()).toBe(0); // a reply, not an error
  });

  test("commitTerminalReply drops a late reply after the sweep already terminalized the turn", async () => {
    await armTurnTimeout(queue, routing("dep-5b", "m"));
    await expireAllMarkers();
    // Deadline lapsed → sweep emits the terminal error and deletes the marker.
    expect(await sweepExpiredTurns("worker unresponsive")).toBe(1);
    expect(await errorRowCount()).toBe(1);

    // A worker reply that arrives AFTER the sweep must NOT double-signal: there
    // is no pending marker left to win, so commitTerminalReply emits nothing.
    const emitted = await commitTerminalReply("dep-5b", ["m"], reply("dep-5b", "m"), null);

    expect(emitted).toBe(false);
    expect(await threadResponseCount()).toBe(1); // still just the sweep's error
    expect(await errorRowCount()).toBe(1);
  });

  test("sweep fails lapsed turns (hung/pod-death) exactly once", async () => {
    await armTurnTimeout(queue, routing("dep-6", "m"));
    await expireAllMarkers();

    expect(await sweepExpiredTurns("worker unresponsive")).toBe(1);
    expect(await markerCount("dep-6")).toBe(0);
    expect(await errorRowCount()).toBe(1);

    expect(await sweepExpiredTurns("worker unresponsive")).toBe(0);
    expect(await errorRowCount()).toBe(1);
  });

  test("a live worker's heartbeat extends the deadline (sweep does not fire)", async () => {
    await armTurnTimeout(queue, routing("dep-7", "m"));
    await expireAllMarkers(); // simulate the deadline having lapsed

    await extendTurnDeadlines("dep-7"); // heartbeat pushes it forward

    expect(await sweepExpiredTurns("worker unresponsive")).toBe(0);
    expect(await markerCount("dep-7")).toBe(1);
    expect(await errorRowCount()).toBe(0);
  });

  test("marker key is globally unique: same messageId in two deployments is isolated", async () => {
    await armTurnTimeout(queue, routing("dep-A", "same"));
    await armTurnTimeout(queue, routing("dep-B", "same"));
    expect(await markerCount()).toBe(2);

    // Discharging one conversation (via the production commitTerminalReply
    // path) must not touch the other's marker.
    await commitTerminalReply("dep-A", ["same"], reply("dep-A", "same"), null);
    expect(await markerCount("dep-A")).toBe(0);
    expect(await markerCount("dep-B")).toBe(1);
  });
});
