/**
 * Claim-side recycle gate, driven through the dispatch chokepoint.
 *
 * These tests exercise `WorkerJobRouter.handleJob` end-to-end through the
 * queue handler it registers (the same contract `RunsQueue` drives in
 * production: handler return = delivered/completed, handler throw = retry),
 * with a real `WorkerConnectionManager` carrying the SSE writer. The defect
 * this pins: on main, a claimed turn is delivered to whatever worker is
 * connected, even when that worker's connector lease is dying or its tooling
 * no longer matches the org's connections — the worker read its env once at
 * process start and cannot be fixed in place. Delete the gate call in
 * `handleJob` (main's behavior) and every "not delivered" assertion here goes
 * red.
 *
 * The DB-backed halves live elsewhere: the liveness probe SQL in
 * `turn-liveness-deployment-probe.test.ts` and fingerprint/lease recording in
 * `agent-tooling-resolver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentErrorCode, type MessagePayload } from "@lobu/core";
import { WorkerConnectionManager } from "../gateway/connection-manager.js";
import type { DispatchRecycler } from "../gateway/dispatch-recycle.js";
import { StaleWorkerError } from "../gateway/dispatch-recycle.js";
import { WorkerJobRouter } from "../gateway/job-router.js";
import { generateDeploymentName } from "../orchestration/deployment-manager.js";
import {
  cleanupTestEnv,
  MockMessageQueue,
  MockResponse,
  setupTestEnv,
  TestHelpers,
} from "./setup.js";

/** Conversation identity for the deployment under test. */
const IDENTITY = {
  userId: "user-1",
  conversationId: "conv-1",
  channelId: "chan-1",
  platform: "api",
  agentId: "agent-1",
  organizationId: "org-1",
};
const DEPLOYMENT = generateDeploymentName(IDENTITY);
const QUEUE = `thread_message_${DEPLOYMENT}`;

function makePayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    ...IDENTITY,
    messageId: "m-1",
    botId: "bot",
    messageText: "hello",
    platformMetadata: {},
    agentOptions: {},
    toolingFingerprint: "fp-current",
    runId: 100,
    ...overrides,
  } as MessagePayload;
}

/**
 * Recycler fake with the same observable surface the DeploymentManager
 * provides. `staleFingerprint`/`staleLease` model the deployment's recorded
 * state; `recycleWorkerDeployment` records the call and — like the real one —
 * leaves the rebuilt deployment fresh.
 */
class FakeRecycler implements DispatchRecycler {
  /** Fingerprint the deployment was "born" with, or null = unknown. */
  bornFingerprint: string | null = "fp-current";
  bornAtRunId: number | null = null;
  leaseExpiring = false;
  recycled: Array<{ deploymentName: string; payload: MessagePayload }> = [];
  recycleError: Error | null = null;
  toolingChecks: Array<{ fingerprint: string; observedAtRunId?: number }> = [];

  hasToolingChanged(
    deploymentName: string,
    fingerprint: string,
    observedAtRunId?: number
  ): boolean {
    this.toolingChecks.push({ fingerprint, observedAtRunId });
    if (deploymentName !== DEPLOYMENT) return false;
    if (this.bornFingerprint === null) return false;
    if (this.bornFingerprint === fingerprint) return false;
    if (
      observedAtRunId != null &&
      this.bornAtRunId != null &&
      observedAtRunId <= this.bornAtRunId
    ) {
      return false;
    }
    return true;
  }

  hasExpiringLease(_deploymentName: string): boolean {
    // Name-agnostic on purpose: the out-of-scope test below asserts the gate
    // never even consults staleness for a payload that does not derive the
    // queue's deployment name.
    return this.leaseExpiring;
  }

  async recycleWorkerDeployment(
    deploymentName: string,
    payload: MessagePayload
  ): Promise<void> {
    if (this.recycleError) throw this.recycleError;
    this.recycled.push({ deploymentName, payload });
    // Rebuild resolves the CURRENT tooling and mints a fresh lease.
    this.bornFingerprint = payload.toolingFingerprint ?? null;
    this.bornAtRunId = payload.runId ?? null;
    this.leaseExpiring = false;
  }
}

describe("claim-side recycle gate at the dispatch chokepoint", () => {
  let queue: MockMessageQueue;
  let connectionManager: WorkerConnectionManager;
  let router: WorkerJobRouter;
  let recycler: FakeRecycler;
  let liveTurn: boolean;
  let terminalized: Array<{
    deploymentName: string;
    messageId: string;
    code: AgentErrorCode;
  }>;
  let terminalizeError: Error | null;
  /** What the election reports: false = it lost, the turn was already terminal. */
  let terminalizeResult: boolean;
  /** Runs-row ids the FIFO fence reports an outranking pending sibling for. */
  let fencedRunIds: Set<number>;
  let res: MockResponse;

  /** SSE `job` events written to the current connection's writer. */
  function deliveredJobs(): unknown[] {
    return TestHelpers.parseSSE(res.getAllWrites()).filter(
      (e: { event?: string }) => e.event === "job"
    );
  }

  /** One claim attempt: delivers (acking the receipt) or rejects. */
  async function attemptOnce(
    payload: MessagePayload,
    id = "run-100"
  ): Promise<void> {
    const before = deliveredJobs().length;
    const attempt = queue.addJob(QUEUE, { id, data: payload });
    // Ack a delivery receipt once one is sent, so a successful delivery
    // resolves instead of timing out. The gate's async probes take a variable
    // number of microtask ticks before the SSE write, so drain a bounded
    // number rather than exactly one.
    for (let i = 0; i < 32 && deliveredJobs().length === before; i++) {
      await Promise.resolve();
    }
    const jobEvent = deliveredJobs().at(-1) as
      | { data?: { jobId?: string } }
      | undefined;
    if (jobEvent?.data?.jobId) router.acknowledgeJob(jobEvent.data.jobId);
    await attempt;
  }

  beforeEach(async () => {
    setupTestEnv();
    queue = new MockMessageQueue();
    connectionManager = new WorkerConnectionManager();
    recycler = new FakeRecycler();
    liveTurn = false;
    router = new WorkerJobRouter(
      queue as never,
      connectionManager,
      async () => []
    );
    terminalized = [];
    terminalizeError = null;
    terminalizeResult = true;
    fencedRunIds = new Set();
    router.setDispatchRecycler(
      recycler,
      async (deploymentName) => {
        expect(deploymentName).toBe(DEPLOYMENT);
        return liveTurn;
      },
      async (deploymentName, messageId, code) => {
        if (terminalizeError) throw terminalizeError;
        terminalized.push({ deploymentName, messageId, code });
        return terminalizeResult;
      },
      async (jobRunId) => fencedRunIds.has(jobRunId)
    );
    res = new MockResponse();
    connectionManager.addConnection(
      DEPLOYMENT,
      IDENTITY.userId,
      "thread-1",
      IDENTITY.agentId,
      res as never
    );
    await router.registerWorker(DEPLOYMENT);
    res.clearWrites();
  });

  afterEach(() => {
    router.shutdown();
    connectionManager.shutdown();
    cleanupTestEnv();
  });

  test("fresh worker: the job is delivered exactly as before the gate", async () => {
    await attemptOnce(makePayload());
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(0);
  });

  test("no fingerprint stamp + healthy lease: delivered (no evidence of change)", async () => {
    recycler.bornFingerprint = "fp-old"; // would mismatch, but nothing observed
    await attemptOnce(makePayload({ toolingFingerprint: undefined }));
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(0);
  });

  test("scenario (a): tooling changed → worker recreated under the SAME name before delivery", async () => {
    recycler.bornFingerprint = "fp-old";

    // First attempt: NOT delivered to the stale worker; recycled instead.
    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(deliveredJobs()).toHaveLength(0);
    expect(recycler.recycled).toHaveLength(1);
    expect(recycler.recycled[0]?.deploymentName).toBe(DEPLOYMENT);

    // The fresh worker attaches (same name — replay, secrets and tokens all
    // key on it) and the queue's retry delivers.
    connectionManager.removeConnection(DEPLOYMENT);
    res = new MockResponse();
    connectionManager.addConnection(
      DEPLOYMENT,
      IDENTITY.userId,
      "thread-1",
      IDENTITY.agentId,
      res as never
    );
    await attemptOnce(makePayload());
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(1); // no second recycle
  });

  test("scenario (b): lease expiring → same recycle-then-retry, same name", async () => {
    recycler.leaseExpiring = true;

    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(deliveredJobs()).toHaveLength(0);
    expect(recycler.recycled).toHaveLength(1);
    expect(recycler.recycled[0]?.deploymentName).toBe(DEPLOYMENT);
    expect(recycler.leaseExpiring).toBe(false); // rebuilt with a fresh lease

    await attemptOnce(makePayload());
    expect(deliveredJobs()).toHaveLength(1);
  });

  test("scenario (c): stale + prior turn live → deferred (no delivery, no teardown), delivered after it terminalizes", async () => {
    recycler.bornFingerprint = "fp-old";
    liveTurn = true;

    // Attempt 1: the queue's native retry is the deferral — the handler
    // throws, nothing is delivered, and crucially the worker is NOT torn down
    // mid-turn.
    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(deliveredJobs()).toHaveLength(0);
    expect(recycler.recycled).toHaveLength(0);

    // Prior turn terminalizes → the next claim recycles and the one after
    // delivers to the fresh worker.
    liveTurn = false;
    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(recycler.recycled).toHaveLength(1);

    connectionManager.removeConnection(DEPLOYMENT);
    res = new MockResponse();
    connectionManager.addConnection(
      DEPLOYMENT,
      IDENTITY.userId,
      "thread-1",
      IDENTITY.agentId,
      res as never
    );
    await attemptOnce(makePayload());
    expect(deliveredJobs()).toHaveLength(1);
  });

  test("scenario (e): rebuild fails → the turn is terminalized and the held job completes (never delivered, never a zombie)", async () => {
    // The teardown may have paused this queue's consumer (SSE disconnect), so
    // a re-thrown job would sit unclaimable until the sweep deadline, then be
    // delivered as a zombie after a later message rebuilds the worker. The
    // gate must instead fail the turn through the marker election — the same
    // outcome the enqueue path gives a create failure — and consume the job.
    recycler.bornFingerprint = "fp-old";
    recycler.recycleError = new Error("secret-store unavailable");

    await queue.addJob(QUEUE, { id: "run-100", data: makePayload() });

    expect(deliveredJobs()).toHaveLength(0);
    expect(terminalized).toEqual([
      {
        deploymentName: DEPLOYMENT,
        messageId: "m-1",
        code: AgentErrorCode.WORKER_STARTUP_FAILED,
      },
    ]);
  });

  test("scenario (e): rebuild fails and the election reports the turn already terminal → the held job still completes", async () => {
    // The election returns false only when it LOST, i.e. the marker was
    // already gone — and a marker is deleted exclusively by the transaction
    // that emits that turn's terminal event (a racing worker reply, the fast
    // path, or the sweep). The turn is answered, so the held job must still be
    // consumed rather than retried into a zombie. An outcome the election
    // cannot confirm throws instead, pinned by the next test.
    recycler.bornFingerprint = "fp-old";
    recycler.recycleError = new Error("secret-store unavailable");
    terminalizeResult = false;

    await queue.addJob(QUEUE, { id: "run-100", data: makePayload() });

    expect(deliveredJobs()).toHaveLength(0);
    expect(terminalized).toHaveLength(1);
  });

  test("scenario (e) FAIL-CLOSED PIN: rebuild AND terminalize fail → the original error propagates, nothing delivered", async () => {
    // If even the election is unreachable, the job must stay undelivered and
    // retry — the sweep remains the backstop. What must never happen is a
    // catch-and-deliver onto the stale worker, or a silent drop of a turn
    // that was never terminalized.
    recycler.bornFingerprint = "fp-old";
    recycler.recycleError = new Error("secret-store unavailable");
    terminalizeError = new Error("db unreachable");

    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toThrow("secret-store unavailable");
    expect(deliveredJobs()).toHaveLength(0);
    expect(terminalized).toHaveLength(0);
  });

  test("FIFO fence: a recycled head turn still reaches the worker before a younger sibling", async () => {
    // The reorder defect: the recycle's queue-native retry pushes head job A's
    // run_at forward while younger job B keeps its original one, so claim
    // order becomes B, A and two back-to-back user messages reach the fresh
    // worker reversed. The gate must defer B while an outranking sibling (A)
    // is still pending — and the fence, not staleness, is what defers it: by
    // the time B is claimed the rebuilt worker is already fresh.
    recycler.bornFingerprint = "fp-old";
    const payloadA = makePayload({ messageId: "m-A" });
    const payloadB = makePayload({ messageId: "m-B" });

    // A claims first: stale + quiet → recycle, then queue-native retry.
    await expect(
      queue.addJob(QUEUE, { id: "1", data: payloadA })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(recycler.recycled).toHaveLength(1);

    // The fresh worker attaches. B is claimed while A sits out its retry
    // delay — without the fence it would deliver here and reverse the
    // conversation.
    connectionManager.removeConnection(DEPLOYMENT);
    res = new MockResponse();
    connectionManager.addConnection(
      DEPLOYMENT,
      IDENTITY.userId,
      "thread-1",
      IDENTITY.agentId,
      res as never
    );
    fencedRunIds.add(2);
    const fenceError = await queue
      .addJob(QUEUE, { id: "2", data: payloadB })
      .catch((e: unknown) => e);
    expect(fenceError).toBeInstanceOf(StaleWorkerError);
    expect((fenceError as StaleWorkerError).reason).toBe("older-turn-pending");
    expect(deliveredJobs()).toHaveLength(0);
    expect(recycler.recycled).toHaveLength(1); // fence ran, staleness never consulted

    // A's retry claims and delivers; A's row is gone, so B follows.
    await attemptOnce(payloadA, "1");
    fencedRunIds.delete(2);
    await attemptOnce(payloadB, "2");

    const order = deliveredJobs().map(
      (e) =>
        (e as { data?: { payload?: { messageId?: string } } }).data?.payload
          ?.messageId
    );
    expect(order).toEqual(["m-A", "m-B"]);
  });

  test("stale job observed BEFORE the rebuild does not tear the fresh worker down again", async () => {
    // The deployment was rebuilt for run 100 (born fp-current). A job stamped
    // fp-old at run 99 — enqueued before the rebuild — mismatches, but the
    // observation predates the deployment, so recycling again would churn the
    // replacement once per queued job (or forever, if tooling changed during
    // the rebuild).
    recycler.bornFingerprint = "fp-current";
    recycler.bornAtRunId = 100;
    await attemptOnce(
      makePayload({ toolingFingerprint: "fp-old", runId: 99 })
    );
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(0);
    expect(recycler.toolingChecks.at(-1)?.observedAtRunId).toBe(99);
  });

  test("a payload that does not derive this deployment's name is out of the gate's scope", async () => {
    // `api-${agentId}` family / legacy lanes: recycling them from a
    // conversation payload would delete one deployment and recreate another.
    recycler.leaseExpiring = true;
    const apiDeployment = "api-agent-1";
    const apiQueue = `thread_message_${apiDeployment}`;
    const apiRes = new MockResponse();
    connectionManager.addConnection(
      apiDeployment,
      IDENTITY.userId,
      "thread-1",
      IDENTITY.agentId,
      apiRes as never
    );
    await router.registerWorker(apiDeployment);
    apiRes.clearWrites();

    const attempt = queue.addJob(apiQueue, {
      id: "run-100",
      data: makePayload(),
    });
    await Promise.resolve();
    const jobEvent = TestHelpers.parseSSE(apiRes.getAllWrites()).find(
      (e: { event?: string }) => e.event === "job"
    ) as { data?: { jobId?: string } } | undefined;
    if (jobEvent?.data?.jobId) router.acknowledgeJob(jobEvent.data.jobId);
    await attempt;

    expect(jobEvent).toBeDefined();
    expect(recycler.recycled).toHaveLength(0);
  });
});
