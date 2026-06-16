/**
 * Multi-replica reliability: a losing replica must DROP a spawn silently when
 * another pod already owns the conversation turn.
 *
 * ## The bug (prod, 2026-06-15)
 * Under N>1 app replicas both pods drain the shared `thread_message` queue and
 * race to spawn the same per-conversation worker. Exactly one wins the
 * per-conversation advisory lock and runs the worker to completion. The LOSING
 * pod hit "Conversation lock busy on another pod", burned 3 retries (~14s),
 * then surfaced a user-facing "Worker startup failed …" error (and a Critical
 * log) — clobbering the winner's real reply ~50% of the time on slow models.
 *
 * ## The fix
 * Lock-busy-on-another-pod is the cross-pod "handled elsewhere" signal, not a
 * failure. The deployment manager throws the typed
 * `ConversationOwnedElsewhereError`; the consumer drops it silently: no retry,
 * no `trackFailedDeployment` (which would emit the user error AND race the
 * winner's reply to terminalize the shared turn marker). A GENUINE startup
 * failure (OOM, spawn failure, bad config) still surfaces via
 * `trackFailedDeployment`.
 *
 * RED before the fix: the owned-elsewhere case called `trackFailedDeployment`
 * (user error) just like a genuine failure. GREEN after: only the genuine
 * failure does.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  ConversationOwnedElsewhereError,
  type MessagePayload,
} from "@lobu/core";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import type {
  BaseDeploymentManager,
  OrchestratorConfig,
} from "../orchestration/base-deployment-manager.js";
import { MessageConsumer } from "../orchestration/message-consumer.js";

// A no-op queue so `armTurnTimeout` / `sendToWorkerQueue` don't touch Postgres.
// `send` returns a non-empty jobId so `sendToWorkerQueue`'s null-check passes.
function makeFakeQueue(): IMessageQueue {
  return {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    createQueue: mock(async () => {}),
    send: mock(async () => "job-1"),
    work: mock(async () => {}),
    pauseWorker: mock(async () => {}),
    resumeWorker: mock(async () => {}),
    getQueueStats: mock(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    })),
    isHealthy: mock(() => true),
  } as unknown as IMessageQueue;
}

function makeConfig(): OrchestratorConfig {
  return {
    queues: { retryLimit: 3, expireInSeconds: 600 },
    worker: { maxDeployments: 0 },
  } as unknown as OrchestratorConfig;
}

// A deployment manager whose `createWorkerDeployment` throws a caller-supplied
// error. `listDeployments` returns empty so `ensureWorkerExists` takes the
// "new thread → create" branch.
function makeDeploymentManager(
  throwOnCreate: Error,
): BaseDeploymentManager {
  return {
    listDeployments: mock(async () => []),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {
      throw throwOnCreate;
    }),
  } as unknown as BaseDeploymentManager;
}

function makePayload(): MessagePayload {
  return {
    messageId: "msg-1",
    userId: "user-1",
    channelId: "chan-1",
    conversationId: "conv-1",
    platform: "slack",
    organizationId: "org-1",
    agentId: "agent-1",
    messageText: "hi",
    platformMetadata: {},
  } as unknown as MessagePayload;
}

/**
 * Poll `pred` until true, THROWING if the deadline lapses. Throwing (vs
 * returning silently) is load-bearing: the negative assertions below
 * ("trackFailedDeployment never called") would pass spuriously if the awaited
 * background path simply never ran — a timeout must fail the test, not be
 * mistaken for the expected behavior.
 */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Drive `handleMessage`, then wait for the background `ensureWorkerExists` chain
 * (and its `.catch`) to settle — it's fire-and-forget. `done` lets the caller
 * poll for the terminal observable (spy called, or createWorkerDeployment
 * attempted N times) instead of guessing a fixed sleep; the genuine-failure
 * path burns ~14s of retry backoff before it settles.
 */
async function runTurn(
  consumer: MessageConsumer,
  done: () => boolean,
): Promise<void> {
  await (
    consumer as unknown as {
      handleMessage: (job: unknown) => Promise<void>;
    }
  ).handleMessage({ id: "1", data: makePayload() });
  await waitFor(done);
  // Brief settle so any trailing `.catch`/`.then` microtasks flush before the
  // negative assertions ("never called") read the spy.
  await new Promise((r) => setTimeout(r, 50));
}

describe("multi-replica: conversation owned by another pod", () => {
  test("owned-elsewhere → drops silently, no user-facing failure", async () => {
    const consumer = new MessageConsumer(
      makeConfig(),
      makeDeploymentManager(
        new ConversationOwnedElsewhereError("owned by another replica"),
      ),
      makeFakeQueue(),
    );

    const dm = (consumer as unknown as { deploymentManager: BaseDeploymentManager })
      .deploymentManager;
    const trackSpy = spyOn(
      consumer as unknown as {
        trackFailedDeployment: (...args: unknown[]) => Promise<void>;
      },
      "trackFailedDeployment",
    ).mockResolvedValue(undefined);

    // The owned-elsewhere signal aborts after exactly one create attempt, so we
    // can wait on that as the terminal observable.
    await runTurn(
      consumer,
      () =>
        (dm.createWorkerDeployment as unknown as { mock: { calls: unknown[] } })
          .mock.calls.length >= 1,
    );

    // The whole point: the losing replica must NOT surface a startup-failure
    // error to the user. `trackFailedDeployment` is the sole producer of the
    // "Worker startup failed …" terminal error, so it must never run here.
    expect(trackSpy).not.toHaveBeenCalled();
  });

  test("genuine startup failure → still surfaces a user-facing error", async () => {
    const consumer = new MessageConsumer(
      makeConfig(),
      makeDeploymentManager(new Error("worker spawn failed: OOM")),
      makeFakeQueue(),
    );

    const trackSpy = spyOn(
      consumer as unknown as {
        trackFailedDeployment: (...args: unknown[]) => Promise<void>;
      },
      "trackFailedDeployment",
    ).mockResolvedValue(undefined);

    // Genuine failures retry 3× with linear backoff (~14s) before
    // `trackFailedDeployment` fires, so wait on the spy directly.
    await runTurn(consumer, () => trackSpy.mock.calls.length >= 1);

    // A real failure MUST still reach the user — don't regress the genuine path.
    expect(trackSpy).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("owned-elsewhere aborts retries immediately (no 3× backoff)", async () => {
    const dm = makeDeploymentManager(
      new ConversationOwnedElsewhereError("owned by another replica"),
    );
    const consumer = new MessageConsumer(makeConfig(), dm, makeFakeQueue());

    spyOn(
      consumer as unknown as {
        trackFailedDeployment: (...args: unknown[]) => Promise<void>;
      },
      "trackFailedDeployment",
    ).mockResolvedValue(undefined);

    await runTurn(
      consumer,
      () =>
        (dm.createWorkerDeployment as unknown as { mock: { calls: unknown[] } })
          .mock.calls.length >= 1,
    );

    // shouldRetry short-circuits the owned-elsewhere signal: createWorkerDeployment
    // is attempted exactly once, not maxRetries+1 times (~14s of wasted backoff).
    expect(
      (dm.createWorkerDeployment as unknown as { mock: { calls: unknown[] } })
        .mock.calls.length,
    ).toBe(1);
  });
});
