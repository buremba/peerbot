/**
 * The recycle DECISION, at the consumer boundary.
 *
 * The resolver/manager helpers (`hasExpiringLease`, `hasToolingChanged`) are
 * pinned by `agent-tooling-resolver.test.ts`. What that suite cannot see is the
 * wiring: whether the consumer actually calls them, with what, and — critically
 * — WHERE in the turn it does so. Deleting the recycle call, or moving it after
 * the message is enqueued, leaves that suite entirely green while breaking the
 * feature or dropping a user's reply.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  DeploymentManager,
  type DeploymentInfo,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import { MessageConsumer } from "../orchestration/message-consumer.js";

const DEPLOYMENT = "deploy-recycle";

const CONFIG: OrchestratorConfig = {
  queues: { retryLimit: 3, retryDelay: 5, expireInSeconds: 300 },
  worker: { idleCleanupMinutes: 60, maxDeployments: 10 },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

/** Records what the consumer asked of the manager, and what it tore down. */
class RecordingManager extends DeploymentManager {
  deleted: string[] = [];
  lowLevelDeleted: string[] = [];
  expiringLeaseFor: string | null = null;
  changedFingerprint: string | null = null;
  /** Deployments this manager reports as existing. */
  existing: string[] = [DEPLOYMENT];

  async listDeployments(): Promise<DeploymentInfo[]> {
    return this.existing.map((deploymentName) => ({
      deploymentName,
      lastActivity: new Date(),
      minutesIdle: 0,
      daysSinceActivity: 0,
      replicas: 1,
      isIdle: false,
      isVeryOld: false,
    }));
  }
  protected async spawnDeployment(): Promise<void> {}
  async scaleDeployment(): Promise<void> {}
  async updateDeploymentActivity(): Promise<void> {}
  async validateWorkerImage(): Promise<void> {}
  protected getDispatcherHost(): string {
    return "localhost";
  }

  async deleteDeployment(name: string): Promise<void> {
    this.lowLevelDeleted.push(name);
  }
  /**
   * The recycle must go through here, not `deleteDeployment`: this is the path
   * that also clears secret placeholder mappings and the backing deployment
   * secrets. Calling the low-level one leaks both on every recycle.
   */
  async deleteWorkerDeployment(name: string): Promise<void> {
    this.deleted.push(name);
    await this.deleteDeployment(name);
  }
  hasExpiringLease(name: string): boolean {
    return this.expiringLeaseFor === name;
  }
  hasToolingChanged(name: string, fingerprint: string): boolean {
    return (
      this.changedFingerprint !== null &&
      name === DEPLOYMENT &&
      fingerprint === this.changedFingerprint
    );
  }
}

/** Exposes the private recycle step under test. */
class TestConsumer extends MessageConsumer {
  recycle(
    deploymentName: string,
    fingerprint: string | null
  ): Promise<void> {
    return (
      this as unknown as {
        recycleStaleDeployment(
          d: string,
          f: string | null,
          t: string
        ): Promise<void>;
      }
    ).recycleStaleDeployment(deploymentName, fingerprint, "trace-1");
  }
}

/** The recycle step touches neither the queue nor the input journal. */
const NOOP_QUEUE = {} as unknown as IMessageQueue;

function build(options?: { liveTurn?: boolean }): {
  manager: RecordingManager;
  consumer: TestConsumer;
} {
  const manager = new RecordingManager(CONFIG);
  const consumer = new TestConsumer(
    CONFIG,
    manager,
    NOOP_QUEUE,
    async () => {},
    async () => options?.liveTurn === true
  );
  return { manager, consumer };
}

describe("stale-deployment recycling", () => {
  test("recycles when the connector lease is expiring", async () => {
    const { manager, consumer } = build();
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("recycles when the org's connector tooling changed", async () => {
    const { manager, consumer } = build();
    manager.changedFingerprint = "fp-new";

    await consumer.recycle(DEPLOYMENT, "fp-new");

    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("leaves a healthy deployment alone", async () => {
    const { manager, consumer } = build();

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    // Recycling a healthy worker every turn would be worse than the staleness
    // this exists to fix: every turn would pay a cold start.
    expect(manager.deleted).toEqual([]);
  });

  test("a failed tooling resolution is not treated as a change", async () => {
    const { manager, consumer } = build();
    manager.changedFingerprint = "fp-new";

    // null = resolution failed this turn. Absent evidence must not tear down a
    // working deployment, or a transient DB blip recycles every warm worker.
    await consumer.recycle(DEPLOYMENT, null);

    expect(manager.deleted).toEqual([]);
  });

  test("does not tear down a deployment that does not exist", async () => {
    const { manager, consumer } = build();
    manager.expiringLeaseFor = DEPLOYMENT;
    manager.existing = [];

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([]);
  });

  test("REGRESSION: never SIGTERM a worker running a PREVIOUS turn", async () => {
    // Pre-enqueue ordering protects only the CURRENT turn. Message 1 starts a
    // long turn; message 2 arrives and, without this check, tears down the
    // worker executing message 1 — the user loses that reply entirely.
    // The durable turn marker is the authority (Postgres, so it also sees a
    // turn started by another replica).
    const { manager, consumer } = build({ liveTurn: true });
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([]);
  });

  test("recycles once the in-flight turn has finished", async () => {
    const { manager, consumer } = build({ liveTurn: false });
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    // Deferral must not be permanent, or the credential never renews.
    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("INVARIANT: the recycle runs BEFORE the turn is enqueued", async () => {
    // Order is the whole safety property. After enqueue, a warm worker can
    // claim the turn at any moment and no idleness check closes the window —
    // the worker can start between the check and the SIGTERM, so the reply is
    // lost. Before enqueue, a teardown can only interrupt a previous turn.
    //
    // Asserted against the source because the hazard is positional: any
    // behavioral mock would still pass with the call moved after the enqueue.
    const source = readFileSync(
      new URL(
        "../orchestration/message-consumer.ts",
        import.meta.url
      ),
      "utf8"
    );
    const recycleAt = source.indexOf("await this.recycleStaleDeployment(");
    const armAt = source.indexOf("await armTurnTimeout(");
    const enqueueAt = source.indexOf("await this.sendToWorkerQueue(");

    expect(recycleAt).toBeGreaterThan(-1);
    expect(armAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeGreaterThan(-1);
    // Before the liveness marker is armed, and before the queue send.
    expect(recycleAt).toBeLessThan(armAt);
    expect(recycleAt).toBeLessThan(enqueueAt);
  });

  test("REGRESSION: recycling cleans up deployment secrets", async () => {
    // The low-level deleteDeployment leaves secret placeholder mappings and
    // the backing `deployments/{name}/` entries behind. A recycle fires about
    // once per credential lifetime per conversation, so that leaks steadily —
    // and AWS Secrets Manager entries would leak permanently.
    const { manager, consumer } = build();
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("a teardown failure never propagates", async () => {
    const { manager, consumer } = build();
    manager.expiringLeaseFor = DEPLOYMENT;
    manager.deleteWorkerDeployment = async () => {
      throw new Error("kill failed");
    };

    // A stale credential beats a failed turn: the idle reaper clears it later.
    await expect(
      consumer.recycle(DEPLOYMENT, "fp-unchanged")
    ).resolves.toBeUndefined();
  });
});

describe("multi-replica backstop (reconcile loop)", () => {
  // With N replicas, a conversation pinned to pod A's worker can have every
  // message claimed by other pods — they enqueue, A's worker drains, and the
  // non-owners drop with ConversationOwnedElsewhereError without ever
  // evaluating the recycle. So the message path alone would let pod A serve
  // turns on a dead credential indefinitely. reconcileDeployments runs on each
  // pod over its OWN deployments, so the owner always re-evaluates.

  class ReconcilingManager extends RecordingManager {
    liveTurn = false;
    protected async isServingLiveTurn(): Promise<boolean> {
      return this.liveTurn;
    }
    // The reconcile classifies on these; keep the worker "in use" so it is
    // neither idle-scaled nor age-reaped, isolating the lease path.
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
  }

  test("the owning pod reaps its own stale-credentialed worker", async () => {
    const manager = new ReconcilingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;

    await manager.reconcileDeployments();

    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("a healthy worker is not reaped", async () => {
    const manager = new ReconcilingManager(CONFIG);

    await manager.reconcileDeployments();

    expect(manager.deleted).toEqual([]);
  });

  test("a worker mid-turn is left alone until the next cycle", async () => {
    const manager = new ReconcilingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    manager.liveTurn = true;

    await manager.reconcileDeployments();

    expect(manager.deleted).toEqual([]);
  });
});

describe("deferral is retried, not lost", () => {
  test("a turn deferred by liveness recycles on the next turn", async () => {
    // The trigger is STATE, not an event: hasExpiringLease/hasToolingChanged
    // are recomputed every turn, so a deferral costs one turn of staleness
    // rather than disabling the recycle until the idle reaper.
    const manager = new RecordingManager(CONFIG);
    let live = true;
    const consumer = new TestConsumer(
      CONFIG,
      manager,
      NOOP_QUEUE,
      async () => {},
      async () => live
    );
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");
    expect(manager.deleted).toEqual([]);

    // The prior turn finishes; the next message re-evaluates and recycles.
    live = false;
    await consumer.recycle(DEPLOYMENT, "fp-unchanged");
    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });
});
