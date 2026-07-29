/**
 * `hasLiveTurnForDeployment` against real `runs` rows.
 *
 * The recycle path consults this before tearing a worker down, and the wiring
 * suite injects a stub for it — so without this file the actual SQL is executed
 * by nothing, and inverting its deadline predicate or dropping the deployment
 * filter would leave every suite green while the recycle SIGTERMs live turns.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
  lockDeploymentTurnInTransaction,
  withDeploymentTurnLock,
} from "../infrastructure/deployment-turn-lock.js";
import { RunsQueue } from "../infrastructure/queue/index.js";
import { hasLiveTurnForDeployment } from "../orchestration/turn-liveness.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";
const DEPLOYMENT = "deploy-probe";

/** Insert a turn-liveness marker the way `armTurnTimeout` does. */
async function seedMarker(params: {
  deploymentName?: string;
  messageId?: string;
  /** Seconds from now the deadline lapses; negative = already lapsed. */
  runAtOffsetSec?: number;
  status?: string;
  runType?: string;
  queueName?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES (
      ${params.runType ?? "internal"},
      ${params.queueName ?? TURN_TIMEOUT_QUEUE},
      ${params.status ?? "pending"},
      now() + make_interval(secs => ${params.runAtOffsetSec ?? 60}),
      ${sql.json({
        deploymentName: params.deploymentName ?? DEPLOYMENT,
        messageId: params.messageId ?? "m-1",
      })}
    )
  `;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("hasLiveTurnForDeployment", () => {
  test("no markers means nothing is in flight", async () => {
    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a live marker for this deployment blocks a recycle", async () => {
    await seedMarker({ runAtOffsetSec: 60 });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("finds a live turn regardless of which message armed it", async () => {
    // Deployment-scoped, unlike hasLiveTurnForMessage: the recycle must not
    // interrupt ANY turn on this worker, not just the current message's.
    await seedMarker({ messageId: "some-other-message" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
  });

  test("a lapsed marker does not block a recycle", async () => {
    // 60s with no worker-driven signal means the worker is silent or dead; the
    // sweep will terminalize that turn anyway. Treating it as live would let a
    // hung worker block renewal forever.
    await seedMarker({ runAtOffsetSec: -30 });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("another deployment's live turn is not ours", async () => {
    // Without the deploymentName predicate, any busy conversation anywhere in
    // the fleet would block every recycle.
    await seedMarker({ deploymentName: "deploy-somebody-else" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a completed turn is not in flight", async () => {
    await seedMarker({ status: "completed" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a non-turn-timeout run is not a turn marker", async () => {
    // The `runs` table carries every queued job; only this queue's rows are
    // turn-liveness markers.
    await seedMarker({ queueName: "internal:something_else" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });

  test("a non-internal run_type is not a turn marker", async () => {
    // `armTurnTimeout` writes markers on an `internal:` queue, which
    // classifyQueue maps to run_type 'internal'. The predicate is what keeps
    // this query on `runs_lobu_claim_idx`'s partial index, so dropping it would
    // both widen the probe and turn an index probe into a scan of the 30-day
    // retention.
    await seedMarker({ runType: "chat_message" });

    expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(false);
  });
});

describe("deployment turn lock", () => {
  test("turn-marker transactions serialize with teardown", async () => {
    const sql = getDb();

    await withDeploymentTurnLock(DEPLOYMENT, async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
          await lockDeploymentTurnInTransaction(tx, DEPLOYMENT);
        })
      ).rejects.toMatchObject({ code: "55P03" });
    });

    await expect(
      sql.begin((tx) => lockDeploymentTurnInTransaction(tx, DEPLOYMENT))
    ).resolves.toBeUndefined();
  });

  test("REGRESSION: arming a marker blocks while a teardown holds the lock", async () => {
    // The lock only closes the cross-replica check/delete race if BOTH halves
    // take it. The test above pins the lock primitives against each other, and
    // `seedMarker` inserts by raw SQL — so neither one executes `RunsQueue`'s
    // arm path. Without this, deleting the `lockDeploymentTurnInTransaction`
    // call from `RunsQueue.send` leaves every suite green while a marker armed
    // on replica B can still land after replica A's liveness read and be
    // SIGTERMed by A's teardown.
    const queue = new RunsQueue();
    await queue.start();
    await queue.createQueue(TURN_TIMEOUT_QUEUE);

    let armed = false;
    let pending: Promise<unknown> = Promise.resolve();

    try {
      await withDeploymentTurnLock(DEPLOYMENT, async () => {
        pending = queue
          .send(
            TURN_TIMEOUT_QUEUE,
            { deploymentName: DEPLOYMENT, messageId: "m-lock" },
            { delayMs: 60_000, singletonKey: `${DEPLOYMENT}:m-lock` }
          )
          .then(() => {
            armed = true;
          });

        // Long enough that an unlocked insert would have committed many times
        // over; the lock is held for the whole callback, so it must not.
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(armed).toBe(false);
      });

      // Teardown released the lock — the marker may now land.
      await pending;
      expect(armed).toBe(true);
      expect(await hasLiveTurnForDeployment(DEPLOYMENT)).toBe(true);
    } finally {
      await queue.stop();
    }
  });
});
