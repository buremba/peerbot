/**
 * #1 (round-3): the exact-model allow-list must be enforced at ENQUEUE time —
 * on the payload that `sendToWorkerQueue` serializes into the queue job the
 * worker reads verbatim — NOT only in deployment env-gen. Deployment-time
 * enforcement is defeated by warm/resumed workers (which never re-run
 * createWorkerDeployment) and by the persist-before-deploy ordering.
 *
 * This drives `handleMessage` with a fake queue that captures the persisted
 * payload, a deployment manager exposing a model policy, and asserts the
 * ENQUEUED model was gated to the agent's allow-list — including the warm path
 * (createWorkerDeployment is never reached / returns early).
 */

import { describe, expect, mock, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import type {
  DeploymentManager,
  OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import { enforceModelAllowList } from "../auth/settings/model-selection.js";
import { generateDeploymentName } from "../orchestration/deployment-manager.js";
import { MessageConsumer } from "../orchestration/message-consumer.js";

// The deployment name the consumer derives for makePayload()'s routing keys.
// Returning a deployment with THIS name from listDeployments makes
// ensureWorkerExists take the WARM branch (scaleDeployment only) — proving the
// gate runs even when createWorkerDeployment is never reached.
const WARM_DEPLOYMENT_NAME = generateDeploymentName({
  userId: "user-1",
  platform: "slack",
  channelId: "chan-1",
  conversationId: "conv-1",
});

process.env.ENCRYPTION_KEY ||=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Fake queue that records every `send` payload for later inspection. */
function makeCapturingQueue(): {
  queue: IMessageQueue;
  sends: Array<{ name: string; data: MessagePayload }>;
} {
  const sends: Array<{ name: string; data: MessagePayload }> = [];
  const queue = {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    createQueue: mock(async () => {}),
    send: mock(async (name: string, data: unknown) => {
      // thread_message_* is the worker-facing queue we care about.
      if (name.startsWith("thread_message_")) {
        sends.push({ name, data: data as MessagePayload });
      }
      return "job-1";
    }),
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
  return { queue, sends };
}

function makeConfig(): OrchestratorConfig {
  return {
    queues: { retryLimit: 3, expireInSeconds: 600 },
    worker: { maxDeployments: 0 },
  } as unknown as OrchestratorConfig;
}

/**
 * A deployment manager exposing a model policy and a WARM path: an existing
 * deployment (listDeployments returns the target), so `ensureWorkerExists` only
 * scaleDeployment's — createWorkerDeployment is never called. This is the exact
 * case the deployment-time gate cannot cover.
 */
function makeWarmDeploymentManager(
  allowedRefs: string[] | null
): DeploymentManager {
  return {
    listDeployments: mock(async () => [
      { deploymentName: WARM_DEPLOYMENT_NAME, status: "running" },
    ]),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {
      throw new Error("createWorkerDeployment must NOT be called on the warm path");
    }),
    getProviderCatalogService: () => ({
      // Mirror the real resolveDispatchModel: gate + (here) treat every listed
      // ref as routable, so replacement picks the first listed real model.
      resolveDispatchModel: async (
        _agentId: string,
        _org: string | undefined,
        requested: string | undefined
      ) => {
        const gate = enforceModelAllowList(requested, allowedRefs, () => true);
        return { ...gate, modules: [], allowedRefs };
      },
    }),
  } as unknown as DeploymentManager;
}

/** Deployment manager with NO ProviderCatalogService wired — for R5 #3. */
function makeUnwiredCatalogDeploymentManager(): DeploymentManager {
  return {
    listDeployments: mock(async () => [
      { deploymentName: WARM_DEPLOYMENT_NAME, status: "running" },
    ]),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {}),
    getProviderCatalogService: () => undefined,
  } as unknown as DeploymentManager;
}

/** Deployment manager whose policy lookup THROWS — for the #1 fail-closed test. */
function makeThrowingDeploymentManager(): DeploymentManager {
  return {
    listDeployments: mock(async () => [
      { deploymentName: WARM_DEPLOYMENT_NAME, status: "running" },
    ]),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {
      throw new Error("createWorkerDeployment must NOT be called on the warm path");
    }),
    getProviderCatalogService: () => ({
      resolveDispatchModel: async () => {
        throw new Error("db down");
      },
    }),
  } as unknown as DeploymentManager;
}

/**
 * Deployment manager whose resolveDispatchModel applies routability: only the
 * refs in `routable` are considered routable. Mirrors the real resolver's
 * "first non-sentinel AND routable" replacement — for the #4 test.
 */
function makeRoutableDeploymentManager(
  allowedRefs: string[] | null,
  routable: Set<string>
): DeploymentManager {
  return {
    listDeployments: mock(async () => [
      { deploymentName: WARM_DEPLOYMENT_NAME, status: "running" },
    ]),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {}),
    getProviderCatalogService: () => ({
      resolveDispatchModel: async (
        _agentId: string,
        _org: string | undefined,
        requested: string | undefined
      ) => {
        const gate = enforceModelAllowList(requested, allowedRefs, (r) =>
          routable.has(r)
        );
        return { ...gate, modules: [], allowedRefs };
      },
    }),
  } as unknown as DeploymentManager;
}

function makePayload(model: string | undefined): MessagePayload {
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
    agentOptions: model ? { model } : {},
  } as unknown as MessagePayload;
}

async function drive(
  consumer: MessageConsumer,
  model: string | undefined
): Promise<void> {
  await (
    consumer as unknown as { handleMessage: (job: unknown) => Promise<void> }
  ).handleMessage({ id: "1", data: makePayload(model) });
  // Let the fire-and-forget ensureWorkerExists settle.
  await new Promise((r) => setTimeout(r, 60));
}

describe("#1: exact-model gate enforced at ENQUEUE time (covers warm/resumed)", () => {
  test("a disallowed model on the WARM path is gated BEFORE the payload is persisted", async () => {
    const { queue, sends } = makeCapturingQueue();
    // agent.models = ["openai/gpt-5"]; the request asks for openai/gpt-4o.
    const consumer = new MessageConsumer(
      makeConfig(),
      makeWarmDeploymentManager(["openai/gpt-5"]),
      queue
    );

    await drive(consumer, "openai/gpt-4o");

    // The PERSISTED payload's model was gated to the listed ref — not gpt-4o.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.data.agentOptions?.model).toBe("openai/gpt-5");
    expect(sends[0]?.data.agentOptions?.model).not.toBe("openai/gpt-4o");
  });

  test("an in-list model passes through unchanged", async () => {
    const { queue, sends } = makeCapturingQueue();
    const consumer = new MessageConsumer(
      makeConfig(),
      makeWarmDeploymentManager(["openai/gpt-5", "claude/claude-sonnet-5"]),
      queue
    );

    await drive(consumer, "claude/claude-sonnet-5");

    expect(sends[0]?.data.agentOptions?.model).toBe("claude/claude-sonnet-5");
  });

  test("allow-all (null policy) leaves the requested model unchanged", async () => {
    const { queue, sends } = makeCapturingQueue();
    const consumer = new MessageConsumer(
      makeConfig(),
      makeWarmDeploymentManager(null),
      queue
    );

    await drive(consumer, "anything/goes");

    expect(sends[0]?.data.agentOptions?.model).toBe("anything/goes");
  });

  test("a sentinel-only policy drops the model (fails closed) before persistence", async () => {
    const { queue, sends } = makeCapturingQueue();
    const consumer = new MessageConsumer(
      makeConfig(),
      makeWarmDeploymentManager(["chatgpt/__unresolved__"]),
      queue
    );

    await drive(consumer, "chatgpt/gpt-4o");

    // The disallowed model was dropped; no sentinel/real model reaches the queue.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.data.agentOptions?.model).toBeUndefined();
  });

  test("#1 FAIL CLOSED: a policy-lookup ERROR drops the requested model (never survives on warm)", async () => {
    const { queue, sends } = makeCapturingQueue();
    // resolveDispatchModel throws "db down". The disallowed model MUST NOT
    // survive on the persisted payload — the warm path won't re-gate later.
    const consumer = new MessageConsumer(
      makeConfig(),
      makeThrowingDeploymentManager(),
      queue
    );

    await drive(consumer, "openai/forbidden");

    expect(sends).toHaveLength(1);
    expect(sends[0]?.data.agentOptions?.model).toBeUndefined();
  });

  test("#2 CROSS-TENANT GUARD: a payload with NO organizationId drops the model (never id-only lookup)", async () => {
    const { queue, sends } = makeCapturingQueue();
    const consumer = new MessageConsumer(
      makeConfig(),
      makeWarmDeploymentManager(["openai/gpt-5"]),
      queue
    );

    // No org → the gate must fail closed rather than query the agent id across
    // orgs (a declared agent exists in every org → wrong-tenant policy). Build
    // the payload directly with no organizationId (passing undefined to the
    // helper would trigger its default).
    const payload = makePayload("openai/gpt-4o");
    delete (payload as { organizationId?: string }).organizationId;
    await (
      consumer as unknown as { handleMessage: (job: unknown) => Promise<void> }
    ).handleMessage({ id: "1", data: payload });
    await new Promise((r) => setTimeout(r, 60));

    expect(sends).toHaveLength(1);
    expect(sends[0]?.data.agentOptions?.model).toBeUndefined();
  });

  test("#4 ROUTABILITY: replacement picks the first non-sentinel ROUTABLE ref, not just non-sentinel", async () => {
    const { queue, sends } = makeCapturingQueue();
    // allow=["xai/grok-4","openai/gpt-5"]; xai UNCREDENTIALED, openai routable.
    // A disallowed request must replace onto openai/gpt-5 (routable), NOT the
    // first non-sentinel xai/grok-4 (which would fail at run).
    const consumer = new MessageConsumer(
      makeConfig(),
      makeRoutableDeploymentManager(
        ["xai/grok-4", "openai/gpt-5"],
        new Set(["openai/gpt-5"])
      ),
      queue
    );

    await drive(consumer, "claude/forbidden");

    expect(sends[0]?.data.agentOptions?.model).toBe("openai/gpt-5");
    expect(sends[0]?.data.agentOptions?.model).not.toBe("xai/grok-4");
  });

  test("R5 #3: an UNWIRED ProviderCatalogService drops the requested model (fail closed)", async () => {
    const { queue, sends } = makeCapturingQueue();
    // The catalog isn't injected yet (startup / a persisted job drained before
    // wiring). The unvalidated model MUST NOT survive to the warm worker.
    const consumer = new MessageConsumer(
      makeConfig(),
      makeUnwiredCatalogDeploymentManager(),
      queue
    );

    await drive(consumer, "openai/forbidden");

    expect(sends).toHaveLength(1);
    expect(sends[0]?.data.agentOptions?.model).toBeUndefined();
  });
});
