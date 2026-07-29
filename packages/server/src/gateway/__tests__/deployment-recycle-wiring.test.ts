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
  terminalized: string[] = [];
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
  async deleteWorkerDeployment(
    name: string,
    options?: { failInFlightTurns?: boolean }
  ): Promise<void> {
    this.deleted.push(name);
    if (options?.failInFlightTurns) {
      this.terminalized.push(name);
    }
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
    fingerprint: string | null,
    force = false
  ): Promise<string> {
    return (
      this as unknown as {
        recycleStaleDeployment(
          d: string,
          f: string | null,
          t: string,
          force: boolean
        ): Promise<string>;
      }
    ).recycleStaleDeployment(deploymentName, fingerprint, "trace-1", force);
  }
}

/** The recycle step touches neither the queue nor the input journal. */
const NOOP_QUEUE = {} as unknown as IMessageQueue;
const NOOP_TURN_LOCK = <T>(
  _deploymentName: string,
  action: () => Promise<T>
): Promise<T> => action();

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
    async () => options?.liveTurn === true,
    NOOP_TURN_LOCK
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

  test("a live turn reports `deferred`, not a silent no-op", async () => {
    // The outcome is load-bearing: `handleMessage` holds the arriving message
    // back on `deferred`, and dispatches on anything else. Collapsing this to
    // the same value a healthy worker returns puts the new turn straight onto
    // the stale worker — the bug this branch exists to prevent.
    const { manager, consumer } = build({ liveTurn: true });
    manager.expiringLeaseFor = DEPLOYMENT;

    expect(await consumer.recycle(DEPLOYMENT, "fp-unchanged")).toBe("deferred");
    expect(manager.deleted).toEqual([]);

    // The three non-deferring outcomes are distinguishable from it.
    const healthy = build();
    expect(await healthy.consumer.recycle(DEPLOYMENT, "fp-unchanged")).toBe(
      "unchanged"
    );
    const quiet = build();
    quiet.manager.expiringLeaseFor = DEPLOYMENT;
    expect(await quiet.consumer.recycle(DEPLOYMENT, "fp-unchanged")).toBe(
      "recycled"
    );
  });

  test("forcing overrides the liveness deferral", async () => {
    // The caller's hold budget is what sets `force`. Without it a single turn
    // that runs longer than the credential has left wedges the conversation:
    // every arrival is held, and the hold never resolves.
    const { manager, consumer } = build({ liveTurn: true });
    manager.expiringLeaseFor = DEPLOYMENT;

    expect(await consumer.recycle(DEPLOYMENT, "fp-unchanged", true)).toBe(
      "recycled"
    );
    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(manager.terminalized).toEqual([DEPLOYMENT]);
  });

  test("forcing still leaves a HEALTHY worker alone", async () => {
    // `force` waives the liveness deferral only. A worker with a good
    // credential must never be torn down mid-turn just because some message
    // exhausted its budget.
    const { manager, consumer } = build({ liveTurn: true });

    expect(await consumer.recycle(DEPLOYMENT, "fp-unchanged", true)).toBe(
      "unchanged"
    );
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

  test("holds the cross-pod turn lock across liveness check and teardown", async () => {
    const manager = new RecordingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    let lockHeld = false;
    manager.deleteWorkerDeployment = async (name: string) => {
      expect(lockHeld).toBe(true);
      manager.deleted.push(name);
    };
    const consumer = new TestConsumer(
      CONFIG,
      manager,
      NOOP_QUEUE,
      async () => {},
      async () => {
        expect(lockHeld).toBe(true);
        return false;
      },
      async (_name, action) => {
        lockHeld = true;
        try {
          return await action();
        } finally {
          lockHeld = false;
        }
      }
    );

    await consumer.recycle(DEPLOYMENT, "fp-unchanged");

    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(lockHeld).toBe(false);
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
    // And it must NOT read as `deferred` — that would hold the user's message
    // behind a teardown that is never going to succeed.
    await expect(
      consumer.recycle(DEPLOYMENT, "fp-unchanged")
    ).resolves.toBe("unchanged");
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
    /**
     * Simulates another owner rebuilding this worker while the reconcile was
     * waiting for the shared turn lock — the deployment is classified as stale,
     * then found healthy on the re-check inside the lock.
     */
    rebuiltUnderLock = false;
    protected async isServingLiveTurn(): Promise<boolean> {
      return this.liveTurn;
    }
    protected async hasStaleTooling(): Promise<boolean> {
      return this.staleTooling;
    }
    protected runWithDeploymentTurnLock<T>(
      _deploymentName: string,
      action: () => Promise<T>
    ): Promise<T> {
      if (this.rebuiltUnderLock) {
        this.expiringLeaseFor = null;
        this.staleTooling = false;
      }
      return action();
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

  test("does not reap a fresh replacement after waiting for the turn lock", async () => {
    class ReplacementManager extends ReconcilingManager {
      protected runWithDeploymentTurnLock<T>(
        _deploymentName: string,
        action: () => Promise<T>
      ): Promise<T> {
        // Another replica recycled and rebuilt this deployment before the
        // reconcile acquired the shared lock.
        this.expiringLeaseFor = null;
        this.staleTooling = false;
        return action();
      }
    }
    const manager = new ReplacementManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;

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

  test("REGRESSION: an unbroken run of live turns cannot defer the reap forever", async () => {
    // This is the N>1 shape of the starvation the message path guards against,
    // and the reconcile cannot borrow that guard: with several replicas most
    // messages are claimed by a pod that does not own this worker, so it arms a
    // marker and enqueues without ever evaluating a recycle. The owner then
    // sees a permanently busy deployment. Unbounded, it serves every one of
    // those turns on the expiring credential.
    const manager = new ReconcilingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    manager.liveTurn = true;

    let cycles = 0;
    while (manager.deleted.length === 0 && cycles < 50) {
      cycles += 1;
      await manager.reconcileDeployments();
    }

    expect(manager.deleted).toEqual([DEPLOYMENT]);
    expect(manager.terminalized).toEqual([DEPLOYMENT]);
    // Bounded, and it did wait several cycles first rather than SIGTERMing the
    // very first live turn it saw.
    expect(cycles).toBeGreaterThan(1);
    expect(cycles).toBeLessThan(50);
  });

  test("a rebuilt deployment gets the whole deferral budget again", async () => {
    // Otherwise a deployment that burned its budget, was rebuilt with a fresh
    // credential by another owner, and went stale again later is reaped mid-turn
    // on its very first stale cycle — carrying a spent budget it never earned.
    //
    // Measured against the budget rather than a hard-coded number, so the
    // constant can move without silently making this assertion vacuous.
    const probe = new ReconcilingManager(CONFIG);
    probe.expiringLeaseFor = DEPLOYMENT;
    probe.liveTurn = true;
    let budget = 0;
    while (probe.deleted.length === 0 && budget < 50) {
      budget += 1;
      await probe.reconcileDeployments();
    }
    expect(budget).toBeGreaterThan(1);

    const manager = new ReconcilingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    manager.liveTurn = true;
    // One cycle short of forcing.
    for (let i = 0; i < budget - 1; i += 1) {
      await manager.reconcileDeployments();
    }
    expect(manager.deleted).toEqual([]);

    // Another owner rebuilds it while this cycle waits for the turn lock.
    manager.rebuiltUnderLock = true;
    await manager.reconcileDeployments();
    manager.rebuiltUnderLock = false;

    // Stale again, and entitled to the WHOLE budget again — so the same number
    // of cycles that just fell one short must still fall one short.
    manager.expiringLeaseFor = DEPLOYMENT;
    for (let i = 0; i < budget - 1; i += 1) {
      await manager.reconcileDeployments();
    }
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
          recycleDeferralsByDeployment: Map<string, number>;
        };
        self.leaseExpiryByDeployment.set(name, new Date(Date.now() + 60_000));
        self.leaseMintedAtByDeployment.set(name, new Date(Date.now() - 60_000));
        self.toolingFingerprintByDeployment.set(name, "fp-old");
        self.organizationByDeployment.set(name, "org-old");
        self.recycleDeferralsByDeployment.set(name, 3);
      }
      forget(name: string) {
        (
          this as unknown as { forgetDeploymentTooling(n: string): void }
        ).forgetDeploymentTooling(name);
      }
      mapSizes(): number[] {
        const self = this as unknown as Record<string, Map<string, unknown>>;
        return [
          self.leaseExpiryByDeployment.size,
          self.leaseMintedAtByDeployment.size,
          self.toolingFingerprintByDeployment.size,
          self.organizationByDeployment.size,
          self.recycleDeferralsByDeployment.size,
        ];
      }
    }

    const manager = new Manager(CONFIG);
    manager.seed(DEPLOYMENT);
    expect(manager.mapSizes()).toEqual([1, 1, 1, 1, 1]);

    manager.forget(DEPLOYMENT);

    // Every map, not just the one whose bug prompted the cleanup. A leftover
    // deferral count in particular would hand the NEXT deployment under this
    // name a spent budget and reap it mid-turn on its first stale cycle.
    expect(manager.mapSizes()).toEqual([0, 0, 0, 0, 0]);
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
      async () => false,
      NOOP_TURN_LOCK
    );

    await Promise.all([
      consumer.recycle(DEPLOYMENT, "fp-unchanged"),
      consumer.recycle(DEPLOYMENT, "fp-unchanged"),
    ]);

    expect(sawOverlap).toBe(false);
    // Exactly one teardown, so no delete can land on a replacement worker.
    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("REGRESSION: the handler that LOSES the lock must not dispatch either", async () => {
    // Serializing the teardown is only half the job. The loser still has a
    // message in hand, and reporting "nothing to do" sends it to the very
    // worker the winner is tearing down for an expiring or revoked credential
    // — the same defect as dispatching after a liveness deferral, reached
    // through the local lock instead. Interleaved deliberately: the first
    // handler parks inside the cross-pod lock while the second runs.
    const manager = new RecordingManager(CONFIG);
    manager.expiringLeaseFor = DEPLOYMENT;
    let releaseFirst!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const consumer = new TestConsumer(
      CONFIG,
      manager,
      NOOP_QUEUE,
      async () => {},
      async () => false,
      async (_name, action) => {
        await parked;
        return action();
      }
    );

    const first = consumer.recycle(DEPLOYMENT, "fp-unchanged");
    // Let the first handler take the local lock and block on the turn lock.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await consumer.recycle(DEPLOYMENT, "fp-unchanged")).toBe("deferred");
    expect(manager.deleted).toEqual([]);

    releaseFirst();
    expect(await first).toBe("recycled");
    expect(manager.deleted).toEqual([DEPLOYMENT]);
  });

  test("lock contention over a HEALTHY worker still dispatches", async () => {
    // Staleness is read before the lock is contended for, so an unrelated
    // handler holding it (a create, say) cannot stall turns on a worker that
    // needs nothing. Holding every contended turn would be a fresh starvation.
    const manager = new RecordingManager(CONFIG);
    let releaseFirst!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const consumer = new TestConsumer(
      CONFIG,
      manager,
      NOOP_QUEUE,
      async () => {},
      async () => false,
      async (_name, action) => {
        await parked;
        return action();
      }
    );
    manager.expiringLeaseFor = DEPLOYMENT;
    const first = consumer.recycle(DEPLOYMENT, "fp-unchanged");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // This turn's own view: nothing stale about the worker it wants.
    manager.expiringLeaseFor = null;
    expect(await consumer.recycle(DEPLOYMENT, "fp-unchanged")).toBe(
      "unchanged"
    );

    releaseFirst();
    await first;
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
      async () => live,
      NOOP_TURN_LOCK
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
