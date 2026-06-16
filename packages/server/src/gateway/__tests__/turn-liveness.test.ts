/**
 * Integration tests for turn-liveness (#946) against a real Postgres (embedded
 * PG18 in CI). Exercises the durable election marker end to end: arm, discharge,
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
  hasLiveTurnForMessage,
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

/**
 * The per-turn liveness gate that authorizes worker-token refresh. A fresh
 * token is minted ONLY while an in-flight turn-timeout marker exists for the
 * token's own turn (deployment + messageId); once that turn terminalizes the
 * marker is gone and refresh is denied (the revocation property). These assert
 * the gate tracks the marker across every production terminalization path,
 * against real Postgres so the cross-pod authority (shared `public.runs`) is
 * exercised, not mocked.
 */
describe("hasLiveTurnForMessage (token-refresh liveness gate)", () => {
  test("false when no turn has ever been armed", async () => {
    expect(await hasLiveTurnForMessage("dep-never", "m1")).toBe(false);
  });

  test("true while a turn is in-flight (armed, not discharged)", async () => {
    await armTurnTimeout(queue, routing("dep-live", "m1"));
    expect(await hasLiveTurnForMessage("dep-live", "m1")).toBe(true);
  });

  test("REFRESH DENIED: false after the turn terminalizes via a real reply", async () => {
    await armTurnTimeout(queue, routing("dep-reply", "m1"));
    expect(await hasLiveTurnForMessage("dep-reply", "m1")).toBe(true);

    // Worker replied → commitTerminalReply deletes the marker. Refresh must now
    // be denied — the token chain ends with the work.
    await commitTerminalReply(
      "dep-reply",
      ["m1"],
      reply("dep-reply", "m1"),
      null
    );
    expect(await hasLiveTurnForMessage("dep-reply", "m1")).toBe(false);
  });

  test("REFRESH DENIED: false after the worker dies (fast path)", async () => {
    await armTurnTimeout(queue, routing("dep-dead", "m1"));
    expect(await hasLiveTurnForMessage("dep-dead", "m1")).toBe(true);

    await failTurnsForDeployment("dep-dead", "worker died");
    expect(await hasLiveTurnForMessage("dep-dead", "m1")).toBe(false);
  });

  test("REFRESH DENIED: false for a lapsed-but-UNSWEPT marker (post-deadline, pre-sweep gap)", async () => {
    // The marker row still exists with status='pending' (the sweep runs only on
    // its periodic tick), but its deadline has passed — a hung/dead worker that
    // stopped heartbeating. The gate must NOT authorize refresh here: liveness is
    // the deadline (heartbeat), not whether the sweep has run yet.
    await armTurnTimeout(queue, routing("dep-lapsed", "m1"));
    expect(await hasLiveTurnForMessage("dep-lapsed", "m1")).toBe(true);

    await expireAllMarkers(); // run_at → past, WITHOUT sweeping (row still pending)
    expect(await markerCount("dep-lapsed")).toBe(1); // row not deleted
    expect(await hasLiveTurnForMessage("dep-lapsed", "m1")).toBe(false);

    // And a live heartbeat extend brings it back (legitimately-long turn).
    await extendTurnDeadlines("dep-lapsed");
    expect(await hasLiveTurnForMessage("dep-lapsed", "m1")).toBe(true);
  });

  test("REFRESH DENIED: false after the deadline lapses and is swept (hung worker)", async () => {
    await armTurnTimeout(queue, routing("dep-hung", "m1"));
    expect(await hasLiveTurnForMessage("dep-hung", "m1")).toBe(true);

    await expireAllMarkers();
    await sweepExpiredTurns();
    expect(await hasLiveTurnForMessage("dep-hung", "m1")).toBe(false);
  });

  test(">2h single turn stays refreshable: heartbeat extends keep the gate true past the original deadline", async () => {
    await armTurnTimeout(queue, routing("dep-long", "m1"));
    // Simulate the original deadline having passed...
    await expireAllMarkers();
    // ...but the worker's heartbeat pushed the deadline forward before any sweep.
    await extendTurnDeadlines("dep-long");
    // The marker is still pending → a legitimately-long turn can still refresh.
    expect(await hasLiveTurnForMessage("dep-long", "m1")).toBe(true);
    // And a sweep does NOT terminalize it (deadline is in the future again).
    await sweepExpiredTurns();
    expect(await hasLiveTurnForMessage("dep-long", "m1")).toBe(true);
  });

  test("scoped per deployment: one deployment's live turn doesn't authorize another", async () => {
    await armTurnTimeout(queue, routing("dep-X", "m1"));
    expect(await hasLiveTurnForMessage("dep-X", "m1")).toBe(true);
    expect(await hasLiveTurnForMessage("dep-Y", "m1")).toBe(false);
  });

  test("CROSS-TURN LEAK CLOSED: a completed turn's token can't refresh while a LATER turn on the same deployment is live", async () => {
    // Turn 1 (messageId m1) and turn 2 (messageId m2) on the SAME deployment.
    // Both armed → both live.
    await armTurnTimeout(queue, routing("dep-multi", "m1"));
    await armTurnTimeout(queue, routing("dep-multi", "m2"));
    expect(await hasLiveTurnForMessage("dep-multi", "m1")).toBe(true);
    expect(await hasLiveTurnForMessage("dep-multi", "m2")).toBe(true);

    // Turn 1 completes (its marker is deleted) while turn 2 is STILL live.
    await commitTerminalReply(
      "dep-multi",
      ["m1"],
      reply("dep-multi", "m1"),
      null
    );

    // The KEY assertion: turn 1's (still-valid) token can no longer refresh,
    // even though the deployment has a live turn (m2). A per-deployment gate
    // would have wrongly returned true here — the privilege leak across runs.
    expect(await hasLiveTurnForMessage("dep-multi", "m1")).toBe(false);
    // Turn 2's own token still refreshes (its turn is genuinely live).
    expect(await hasLiveTurnForMessage("dep-multi", "m2")).toBe(true);
  });
});
