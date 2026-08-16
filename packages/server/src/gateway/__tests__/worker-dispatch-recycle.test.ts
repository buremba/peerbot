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
 * `handleJob` (main's automation) and every "not delivered" assertion here goes
 * red.
 *
 * The DB-backed halves live elsewhere: the liveness probe SQL in
 * `turn-liveness-deployment-probe.test.ts` and fingerprint/lease recording in
 * `agent-tooling-resolver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AgentErrorCode,
  ConversationOwnedElsewhereError,
  type MessagePayload,
} from "@lobu/core";
import { WorkerConnectionManager } from "../worker-dispatch/connection-manager.js";
import type { DispatchRecycler } from "../worker-dispatch/dispatch-recycle.js";
import { StaleWorkerError } from "../worker-dispatch/dispatch-recycle.js";
import { WorkerJobRouter } from "../worker-dispatch/job-router.js";
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
 * provides. `bornFingerprint` is what the deployment was built with;
 * `currentFingerprint` is the org's DB-truth declaration digest that
 * `hasToolingDrifted` re-reads; `recycleWorkerDeployment` records the call
 * and — like the real one — rebuilds against the CURRENT truth.
 */
class FakeRecycler implements DispatchRecycler {
  /** Fingerprint the deployment was "born" with, or null = unknown. */
  bornFingerprint: string | null = "fp-current";
  /** The org's current declaration digest (what a rebuild would resolve). */
  currentFingerprint = "fp-current";
  /** Thrown by the drift check — models a resolution infrastructure failure. */
  driftError: Error | null = null;
  driftChecks = 0;
  leaseExpiring = false;
  recycled: Array<{ deploymentName: string; payload: MessagePayload }> = [];
  recycleError: Error | null = null;

  hasToolingStampMismatch(
    deploymentName: string,
    fingerprint: string
  ): boolean {
    if (deploymentName !== DEPLOYMENT) return false;
    if (this.bornFingerprint === null) return false;
    return this.bornFingerprint !== fingerprint;
  }

  async hasToolingDrifted(
    deploymentName: string,
    _payload: MessagePayload
  ): Promise<boolean> {
    this.driftChecks += 1;
    if (this.driftError) throw this.driftError;
    if (deploymentName !== DEPLOYMENT) return false;
    if (this.bornFingerprint === null) return false;
    return this.currentFingerprint !== this.bornFingerprint;
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
    this.bornFingerprint = this.currentFingerprint;
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
    // The hot path (stamp matches born) never consults the DB drift check.
    expect(recycler.driftChecks).toBe(0);
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

  test("scenario (c): stale + a live turn → delivered unrecycled, whatever the message is", async () => {
    // The gate does not inspect the payload here, and must not: whether this
    // message steers the live turn, cancels it, or starts new work depends on
    // preconditions only the worker holds (its current worker handle, whether
    // the batcher is still processing, whether the posting user owns the live
    // turn). Deferring would silently break steering and `/cancel`; exempting
    // only "steerable-looking" payloads promises a protection the gate cannot
    // keep, because the worker can still fall through to new work. So: deliver,
    // and never tear down a running turn.
    recycler.bornFingerprint = "fp-old";
    liveTurn = true;

    for (const payload of [
      makePayload({ messageId: "m-followup" }),
      makePayload({ messageId: "m-cancel", messageText: "/cancel" }),
      makePayload({
        messageId: "m-automation",
        platformMetadata: { source: "scheduled-job" },
      }),
    ]) {
      await attemptOnce(payload);
    }

    expect(deliveredJobs()).toHaveLength(3);
    expect(recycler.recycled).toHaveLength(0); // no mid-turn teardown, ever
  });

  test("scenario (c2): the recycle is deferred, not lost — it happens on the first quiet claim", async () => {
    recycler.bornFingerprint = "fp-old";
    liveTurn = true;
    await attemptOnce(makePayload({ messageId: "m-during" }));
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(0);

    // Turn ends → the next claim finds the worker quiet and rebuilds it before
    // delivering anything else.
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
    // `deliveredJobs()` reads the CURRENT SSE response, so this counts only
    // what the rebuilt worker received.
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

  test("REGRESSION: a cross-pod ownership handoff defers — it never terminalizes the turn", async () => {
    // The recycle's teardown releases this conversation's advisory lock, so
    // another replica can win it before our rebuild takes it back. That throws
    // the typed `ConversationOwnedElsewhereError`, which is a HANDOFF, not a
    // rebuild failure: the winner is bringing the worker up under the same
    // name and its pod will deliver this job. Terminalizing it here would show
    // the user a spurious "worker startup failed" and race the winner's reply
    // to discharge the shared turn marker.
    recycler.bornFingerprint = "fp-old";
    recycler.recycleError = new ConversationOwnedElsewhereError(
      "Conversation owned by another replica"
    );

    const err = (await queue
      .addJob(QUEUE, { id: "run-100", data: makePayload() })
      .catch((e: unknown) => e)) as StaleWorkerError;

    expect(err).toBeInstanceOf(StaleWorkerError);
    expect(err.reason).toBe("ownership-handoff");
    // Deferral contract: the retry must not consume the genuine-failure budget.
    expect((err as unknown as { deferral: boolean }).deferral).toBe(true);
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
    // Every StaleWorkerError is a queue deferral: retried WITHOUT consuming
    // an attempt, so waiting for head-of-line to clear can never exhaust the
    // budget and strand the follower as a failed, never-delivered row.
    expect((fenceError as StaleWorkerError).deferral).toBe(true);
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

  test("an outdated stamp does not churn the fresh worker — DB truth decides, not the stamp", async () => {
    // The deployment was just rebuilt against the current declaration digest.
    // A job stamped fp-old before the rebuild still mismatches, but no
    // chronology can order the stamp (runs.id is not processing order across
    // replicas) — the gate re-reads the truth instead: current == born means
    // the stamp is merely outdated, so it delivers rather than recycling the
    // replacement once per queued job.
    recycler.bornFingerprint = "fp-current";
    recycler.currentFingerprint = "fp-current";
    await attemptOnce(makePayload({ toolingFingerprint: "fp-old" }));
    expect(deliveredJobs()).toHaveLength(1);
    expect(recycler.recycled).toHaveLength(0);
    expect(recycler.driftChecks).toBe(1);
  });

  test("REGRESSION: a newer observation with a LOWER runs.id still recycles", async () => {
    // `runs.id` is NOT processing chronology: message claims run out of id
    // order across replicas, so a lower runId can carry a newer observation. An
    // id-ordered guard would suppress it — a
    // deployment built from run 101 would suppress the genuinely newer
    // fingerprint stamped by run 100 and deliver the turn onto stale tooling.
    // With chronology deleted, the DB-truth drift check decides regardless of
    // runId: current != born → recycle.
    recycler.bornFingerprint = "fp-A";
    recycler.currentFingerprint = "fp-B";
    await expect(
      queue.addJob(QUEUE, {
        id: "run-100",
        data: makePayload({ toolingFingerprint: "fp-B", runId: 100 }),
      })
    ).rejects.toBeInstanceOf(StaleWorkerError);
    expect(recycler.recycled).toHaveLength(1);
    expect(deliveredJobs()).toHaveLength(0);
  });

  test("a drift-check failure propagates — never delivered on unknown state", async () => {
    recycler.bornFingerprint = "fp-old";
    recycler.driftError = new Error("resolver db down");
    await expect(
      queue.addJob(QUEUE, { id: "run-100", data: makePayload() })
    ).rejects.toThrow("resolver db down");
    expect(deliveredJobs()).toHaveLength(0);
    expect(recycler.recycled).toHaveLength(0);
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
