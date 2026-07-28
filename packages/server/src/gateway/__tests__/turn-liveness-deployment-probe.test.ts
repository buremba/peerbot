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
});
