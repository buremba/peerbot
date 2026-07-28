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
    staleTooling = false;
    protected async isServingLiveTurn(): Promise<boolean> {
      return this.liveTurn;
    }
    protected async hasStaleTooling(): Promise<boolean> {
      return this.staleTooling;
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

  test("REGRESSION: a revoked connection is reaped even on a non-owner-claimed conversation", async () => {
    // The message path never runs for this conversation: other replicas claim
    // every message, enqueue to the owner's worker, and drop with
    // ConversationOwnedElsewhereError. Without the reconcile checking tooling
    // — not just expiry — a revoked or repointed GitHub connection would keep
    // executing with the old GH_TOKEN for the rest of the credential's life.
    const manager = new ReconcilingManager(CONFIG);
    manager.staleTooling = true;

    await manager.reconcileDeployments();

    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("stale tooling still defers to an in-flight turn", async () => {
    const manager = new ReconcilingManager(CONFIG);
    manager.staleTooling = true;
    manager.liveTurn = true;

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

describe("recorded lease state is dropped with the worker", () => {
  test("a torn-down deployment leaves no recycle state behind", async () => {
    // A crash, an idle scale-to-0, or a delete must clear EVERY recorded map.
    // A leftover fingerprint makes the next deployment under the same name
    // look "known" when it was never built with that tooling; a leftover
    // expiry arms a recycle for a worker that no longer exists.
    class Manager extends RecordingManager {
      seed(name: string) {
        const self = this as unknown as {
          leaseExpiryByDeployment: Map<string, Date>;
          leaseMintedAtByDeployment: Map<string, Date>;
          toolingFingerprintByDeployment: Map<string, string>;
          organizationByDeployment: Map<string, string>;
        };
        self.leaseExpiryByDeployment.set(name, new Date(Date.now() + 60_000));
        self.leaseMintedAtByDeployment.set(name, new Date(Date.now() - 60_000));
        self.toolingFingerprintByDeployment.set(name, "fp-old");
        self.organizationByDeployment.set(name, "org-old");
      }
      forget(name: string) {
        (this as unknown as { forgetLeaseExpiry(n: string): void })
          .forgetLeaseExpiry(name);
      }
      mapSizes(): number[] {
        const self = this as unknown as Record<string, Map<string, unknown>>;
        return [
          self.leaseExpiryByDeployment.size,
          self.leaseMintedAtByDeployment.size,
          self.toolingFingerprintByDeployment.size,
          self.organizationByDeployment.size,
        ];
      }
    }

    const manager = new Manager(CONFIG);
    manager.seed(DEPLOYMENT);
    expect(manager.mapSizes()).toEqual([1, 1, 1, 1]);

    manager.forget(DEPLOYMENT);

    // Every map, not just the one whose bug prompted the cleanup.
    expect(manager.mapSizes()).toEqual([0, 0, 0, 0]);
    expect(manager.hasExpiringLease(DEPLOYMENT)).toBe(false);
    expect(manager.hasToolingChanged(DEPLOYMENT, "fp-new")).toBe(false);
  });
});

describe("concurrent recycles are serialized", () => {
  test("REGRESSION: two handlers cannot both tear down the same deployment", async () => {
    // Without the per-deployment lock both handlers pass the liveness check and
    // both delete. The SECOND delete lands after the first has already been
    // replaced, so it kills the replacement worker — and a turn was already
    // enqueued to it. Reproduced by codex with an inline two-handler probe.
    const manager = new RecordingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    let inFlight = 0;
    let sawOverlap = false;
    manager.deleteWorkerDeployment = async (name: string) => {
      inFlight += 1;
      if (inFlight > 1) sawOverlap = true;
      // Yield, so a racing handler would interleave here.
      await new Promise((r) => setTimeout(r, 5));
      manager.deleted.push(name);
      inFlight -= 1;
    };
    const consumer = new TestConsumer(
      CONFIG,
      manager,
      NOOP_QUEUE,
      async () => {},
      async () => false
    );

    await Promise.all([
      consumer.recycle(DEPLOYMENT, "fp-unchanged"),
      consumer.recycle(DEPLOYMENT, "fp-unchanged"),
    ]);

    expect(sawOverlap).toBe(false);
    // Exactly one teardown, so no delete can land on a replacement worker.
    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("the lock is released, so a later turn can still recycle", async () => {
    // A lock leaked on the success path would disable recycling for the rest
    // of the process's life.
    const { manager, consumer } = build();
    manager.expiringLeaseFor = DEPLOYMENT;

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");
    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([DEPLOYMENT, DEPLOYMENT]);
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
