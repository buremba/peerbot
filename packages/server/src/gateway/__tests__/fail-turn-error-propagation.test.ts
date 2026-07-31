/**
 * `failTurnIfPending` must PROPAGATE infrastructure failures, never swallow
 * them into `false`. The dispatch gate completes a held job on the strength of
 * this call ("the turn now has its terminal event"); a swallowed DB error
 * would let it complete the job for a turn that was never terminalized — a
 * silent turn drop with no error to the client and no job left to retry.
 * `false` must mean exactly one thing: the election was lost because the turn
 * was already terminalized.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { AgentErrorCode } from "@lobu/core";
import * as dbClient from "../../db/client.js";
import { failTurnIfPending } from "../orchestration/turn-liveness.js";

// Same `spyOn` seam (restored in afterAll) as durable-replay-claim-parity:
// never `mock.module`, which is process-global and leaks into co-running
// DB-backed suites.
const getDbSpy = spyOn(dbClient, "getDb");
afterAll(() => {
  getDbSpy.mockRestore();
});

describe("failTurnIfPending error propagation", () => {
  test("a DB failure rejects instead of resolving false", async () => {
    getDbSpy.mockImplementation(() => {
      throw new Error("connection pool exhausted");
    });

    await expect(
      failTurnIfPending("dep-x", "m-x", AgentErrorCode.WORKER_STARTUP_FAILED)
    ).rejects.toThrow("connection pool exhausted");
  });
});
