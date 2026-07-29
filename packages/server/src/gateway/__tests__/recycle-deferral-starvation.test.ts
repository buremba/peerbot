/**
 * Overlapping turns must not starve the recycle — driven through the real
 * `handleMessage`, not the recycle step in isolation.
 *
 * `deployment-recycle-wiring.test.ts` pins the DECISION (does the consumer tear
 * the worker down, and does it defer to a live turn). It cannot see the hazard
 * this file exists for, because that hazard lives in what happens AFTER the
 * deferral: the same turn goes on to arm its own liveness marker and enqueue
 * onto the very worker we just declined to recycle. That new marker is what the
 * NEXT message's liveness check reads, so under a steady arrival rate every
 * turn defers, every turn arms, and the worker never becomes quiet enough to
 * recycle. The credential it was built with expires, or the connection behind
 * it is repointed/revoked, and the sandbox keeps using it turn after turn.
 *
 * So the properties under test are:
 *  - a message that needs a recycle it cannot perform is NOT dispatched onto
 *    the stale worker, and arms no marker (arming is the starvation mechanism);
 *  - the hold terminates — bounded, whether or not the prior turn ever ends;
 *  - a healthy worker still dispatches immediately, mid-turn or not. A hold
 *    that fires when nothing is stale is the same starvation wearing a hat.
 *
 * The liveness stub is deliberately wired to the queue's armed markers rather
 * than to a fixed boolean: that coupling IS the bug, and a stub that ignores
 * arming would let the starvation regression pass.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import {
  DeploymentManager,
  generateDeploymentName,
  type DeploymentInfo,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import type {
  IMessageQueue,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "../infrastructure/queue/index.js";
import { MessageConsumer } from "../orchestration/message-consumer.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "test-org";
const AGENT = "agent-1";
const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

const CONFIG: OrchestratorConfig = {
  queues: { retryLimit: 3, retryDelay: 5, expireInSeconds: 300 },
  worker: { idleCleanupMinutes: 60, maxDeployments: 10 },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

function payload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m-2",
    channelId: "ch",
    teamId: "t",
    agentId: AGENT,
    organizationId: ORG,
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

const DEPLOYMENT = generateDeploymentName({
  organizationId: ORG,
  agentId: AGENT,
  userId: "u",
  platform: "slack",
  channelId: "ch",
  conversationId: "c",
});

/** A warm worker whose connector lease is inside the recycle margin. */
class StaleWorkerManager extends DeploymentManager {
  deleted: string[] = [];
  /** Flip to false to model a perfectly healthy warm worker. */
  leaseExpiring = true;

  async listDeployments(): Promise<DeploymentInfo[]> {
    return [
      {
        deploymentName: DEPLOYMENT,
        lastActivity: new Date(),
        minutesIdle: 0,
        daysSinceActivity: 0,
        replicas: 1,
        isIdle: false,
        isVeryOld: false,
      },
    ];
  }
  protected async spawnDeployment(): Promise<void> {}
  async scaleDeployment(): Promise<void> {}
  async updateDeploymentActivity(): Promise<void> {}
  async validateWorkerImage(): Promise<void> {}
  async syncNetworkConfigGrants(): Promise<void> {}
  protected getDispatcherHost(): string {
    return "localhost";
  }
  async deleteDeployment(): Promise<void> {}
  async deleteWorkerDeployment(name: string): Promise<void> {
    this.deleted.push(name);
    // A rebuilt worker holds a fresh lease, so the staleness clears with it.
    this.leaseExpiring = false;
  }
  hasExpiringLease(name: string): boolean {
    return this.leaseExpiring && name === DEPLOYMENT;
  }
  hasToolingChanged(): boolean {
    return false;
  }
}

interface Sent {
  queueName: string;
  data: unknown;
  options?: QueueOptions;
}

/**
 * Records every send and models the one piece of real coupling that matters:
 * arming a turn marker makes the deployment look live to the recycle path.
 */
class RecordingQueue implements IMessageQueue {
  sends: Sent[] = [];
  /** messageIds with an armed, undischarged turn marker. */
  liveMarkers = new Set<string>();
  private nextId = 1;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(): Promise<void> {}
  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions
  ): Promise<string> {
    this.sends.push({ queueName, data, options });
    if (queueName === TURN_TIMEOUT_QUEUE) {
      const messageId = (data as { messageId?: string }).messageId;
      if (messageId) this.liveMarkers.add(messageId);
    }
    return String(this.nextId++);
  }
  async work(): Promise<void> {}
  async pauseWorker(): Promise<void> {}
  async resumeWorker(): Promise<void> {}
  async getQueueStats(): Promise<QueueStats> {
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }
  isHealthy(): boolean {
    return true;
  }

  of(queueName: string): Sent[] {
    return this.sends.filter((s) => s.queueName === queueName);
  }
  get armed(): Sent[] {
    return this.of(TURN_TIMEOUT_QUEUE);
  }
  get dispatched(): Sent[] {
    return this.of(`thread_message_${DEPLOYMENT}`);
  }
  get requeued(): Sent[] {
    return this.of("messages");
  }
}

/** Exposes the private queue handler so a message can be driven end-to-end. */
class TestConsumer extends MessageConsumer {
  deliver(runId: number, data: MessagePayload): Promise<void> {
    return (
      this as unknown as {
        handleMessage(job: QueueJob<MessagePayload>): Promise<void>;
      }
    ).handleMessage({ id: String(runId), data, name: "messages" });
  }
}

function build(): {
  queue: RecordingQueue;
  manager: StaleWorkerManager;
  consumer: TestConsumer;
} {
  const queue = new RecordingQueue();
  const manager = new StaleWorkerManager(CONFIG);
  const consumer = new TestConsumer(
    CONFIG,
    manager,
    queue,
    async () => {},
    async (deploymentName: string) =>
      deploymentName === DEPLOYMENT && queue.liveMarkers.size > 0,
    // The cross-pod lock is exercised for real by
    // turn-liveness-deployment-probe.test.ts; here it is a pass-through so the
    // suite stays about the dispatch decision.
    async (_deploymentName, action) => action()
  );
  return { queue, manager, consumer };
}

/** The payload the consumer put back on `messages`, if it held one back. */
function heldBack(queue: RecordingQueue): MessagePayload | null {
  const last = queue.requeued.at(-1);
  return last ? (last.data as MessagePayload) : null;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  await seedAgentRow(AGENT, { organizationId: ORG });
});

describe("a stale worker never serves an overlapping turn", () => {
  test("REGRESSION: the arriving message is not enqueued onto the stale worker", async () => {
    const { queue, manager, consumer } = build();
    // Message 1 is mid-turn on the worker whose lease is expiring.
    queue.liveMarkers.add("m-1");

    await consumer.deliver(101, payload({ messageId: "m-2" }));

    // Not dispatched: the worker holds a credential we have already decided is
    // unfit to serve another turn.
    expect(queue.dispatched).toEqual([]);
    // And NOT armed. Arming is what makes the next arrival defer too, so an
    // implementation that declines to dispatch but still arms has moved the
    // starvation, not removed it.
    expect(queue.armed).toEqual([]);
    // Message 1's reply is still owed, so its worker must survive.
    expect(manager.deleted).toEqual([]);
    // The user's message is held, not dropped: exactly one re-queue.
    expect(queue.requeued).toHaveLength(1);
    expect(heldBack(queue)?.messageId).toBe("m-2");
    expect(heldBack(queue)?.runId).toBeUndefined();
  });

  test("the held message is re-queued with a delay and a fresh idempotency key", async () => {
    const { queue, consumer } = build();
    queue.liveMarkers.add("m-1");

    await consumer.deliver(101, payload({ messageId: "m-2" }));

    const [requeue] = queue.requeued;
    // Immediate re-queue would spin the consumer hot against a turn that runs
    // for seconds to minutes.
    expect(requeue.options?.delayMs).toBeGreaterThan(0);
    // The producer's own singletonKey is already spent by the run being
    // completed here. Reusing it would ON CONFLICT into a no-op and silently
    // drop the user's message.
    expect(requeue.options?.singletonKey).toBeTruthy();
    expect(requeue.options?.singletonKey).not.toContain(":");
  });

  test("REGRESSION: continuous arrivals cannot defer the recycle forever", async () => {
    // The starvation shape: message 1's turn never ends (a long tool loop that
    // keeps heartbeating), and messages keep arriving. Without a bound, the
    // worker serves every one of them on the expiring credential.
    const { queue, manager, consumer } = build();
    queue.liveMarkers.add("m-1");

    let next: MessagePayload | null = payload({ messageId: "m-2" });
    let rounds = 0;
    // Generous ceiling: the assertion is that it terminates at all, and the
    // exact budget is an implementation detail free to move.
    while (next && rounds < 200) {
      rounds += 1;
      await consumer.deliver(100 + rounds, next);
      if (queue.dispatched.length > 0) break;
      const held = heldBack(queue);
      next = held && held !== next ? held : null;
    }

    // It resolved: the worker was recycled and the message finally went out.
    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(queue.dispatched).toHaveLength(1);
    expect(queue.armed).toHaveLength(1);
    expect(rounds).toBeLessThan(200);
    // Every round before the last held the message back rather than serving it
    // on the stale worker.
    expect(queue.requeued).toHaveLength(rounds - 1);
  });

  test("the message goes out as soon as the prior turn discharges", async () => {
    const { queue, manager, consumer } = build();
    queue.liveMarkers.add("m-1");

    await consumer.deliver(101, payload({ messageId: "m-2" }));
    const held = heldBack(queue);
    expect(held).not.toBeNull();
    expect(manager.deleted).toEqual([]);

    // Message 1 replies; its marker is discharged.
    queue.liveMarkers.delete("m-1");
    await consumer.deliver(102, held as MessagePayload);

    // Recycled under the turn lock, THEN armed, THEN dispatched.
    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(queue.armed).toHaveLength(1);
    expect(queue.dispatched).toHaveLength(1);
    const order = queue.sends.map((s) => s.queueName);
    expect(order.indexOf(TURN_TIMEOUT_QUEUE)).toBeLessThan(
      order.indexOf(`thread_message_${DEPLOYMENT}`)
    );
    // The hold counter is gateway bookkeeping. It rides `platformMetadata`,
    // which is signed into the per-run token and forwarded verbatim to the
    // worker, so it must be stripped before either sees it.
    const delivered = queue.dispatched[0].data as MessagePayload;
    expect(Object.keys(delivered.platformMetadata)).not.toContain(
      "lobuRecycleDeferrals"
    );
  });

  test("a healthy warm worker still serves an overlapping turn immediately", async () => {
    // The hold is scoped to workers that must be recycled. Holding turns back
    // whenever any other turn is live would stall every busy conversation —
    // the same starvation, pointed at the user instead of the credential.
    const { queue, manager, consumer } = build();
    manager.leaseExpiring = false;
    queue.liveMarkers.add("m-1");

    await consumer.deliver(101, payload({ messageId: "m-2" }));

    expect(queue.requeued).toEqual([]);
    expect(manager.deleted).toEqual([]);
    expect(queue.armed).toHaveLength(1);
    expect(queue.dispatched).toHaveLength(1);
  });

  test("a quiet stale worker is recycled and the turn dispatched in one pass", async () => {
    const { queue, manager, consumer } = build();

    await consumer.deliver(101, payload({ messageId: "m-2" }));

    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(queue.requeued).toEqual([]);
    expect(queue.dispatched).toHaveLength(1);
  });
});
