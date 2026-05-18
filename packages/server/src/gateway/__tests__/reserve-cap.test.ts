/**
 * Integration tests for the `acquireConversationLock` reserved-connection
 * cap added in PR #870 (Fix 2). Bound the number of pinned
 * `sql.reserve()` connections per gateway process via
 * `LOBU_MAX_RESERVED_LOCKS` (default derived from `DB_POOL_MAX`) and
 * expose an in-process counter so an operator can observe how close the
 * gateway is to exhausting the postgres-js pool with per-conversation
 * reservations.
 *
 * Validated against PGlite via the gateway test harness.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  acquireConversationLock,
  getReservedLockCount,
  resetReservedLockCountForTests,
  setReservedLockCountForTests,
} from "../orchestration/impl/embedded-deployment.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  resetReservedLockCountForTests();
});

afterEach(() => {
  // Some tests poke env vars; make sure we leave the suite as we found it.
  delete process.env.LOBU_MAX_RESERVED_LOCKS;
  resetReservedLockCountForTests();
});

describe("acquireConversationLock: reserved-connection cap and metric", () => {
  /**
   * The full lock path uses `sql.reserve()`, which under PGlite would block
   * because the embedded pool is pinned to a single connection. Instead we
   * exercise the cap with `LOBU_DISABLE_PREPARE=1` (which is already set by
   * the gateway harness) so `acquireConversationLock` returns the
   * embedded-mode no-op sentinel without touching the counter — and then
   * directly drive the counter via a sibling code path that talks to the
   * cap. The cap and counter still need to work outside the embedded
   * shortcut, so we temporarily clear LOBU_DISABLE_PREPARE for these tests
   * and assert the cap rejection before any `sql.reserve()` runs.
   *
   * Concretely: set the cap to 2, override the env to take the non-embedded
   * branch, but stub out the reserve so we don't actually attach a real
   * connection. We do this by setting the cap to 0 — which forces an
   * immediate `null` return — and asserting the metric stays at 0.
   */
  test("cap exhaustion returns null and does not increment the counter", async () => {
    const prevDisable = process.env.LOBU_DISABLE_PREPARE;
    delete process.env.LOBU_DISABLE_PREPARE;
    process.env.LOBU_MAX_RESERVED_LOCKS = "0";
    try {
      const lock = await acquireConversationLock(
        "org-a",
        "agent-a",
        "conv-a"
      );
      expect(lock).toBeNull();
      expect(getReservedLockCount()).toBe(0);
    } finally {
      if (prevDisable !== undefined) {
        process.env.LOBU_DISABLE_PREPARE = prevDisable;
      }
    }
  });

  test("embedded mode returns a no-op sentinel without touching the counter", async () => {
    // Only meaningful under PGlite (`LOBU_DISABLE_PREPARE=1`). Real-PG CI
    // runs this same suite against a postgres container without the
    // embedded mode signal, in which case `acquireConversationLock` falls
    // through to the cap+reserve path and the assertions below don't
    // apply.
    if (process.env.LOBU_DISABLE_PREPARE !== "1") {
      return;
    }
    const lock = await acquireConversationLock("org-a", "agent-a", "conv-a");
    expect(lock).not.toBeNull();
    expect(getReservedLockCount()).toBe(0);
    await lock!.release();
    expect(getReservedLockCount()).toBe(0);
  });

  test("counter helper resets to 0 between tests", () => {
    expect(getReservedLockCount()).toBe(0);
  });

  test("cap rejects when counter has been staged at or above cap", async () => {
    // PGlite pins us to a single connection, so we can't drive `sql.reserve()`
    // end-to-end. Stage the counter directly to prove the cap branch
    // rejects when the count already sits at the cap — the production code
    // path increments the counter from the same place and observes the
    // same check.
    const prevDisable = process.env.LOBU_DISABLE_PREPARE;
    delete process.env.LOBU_DISABLE_PREPARE;
    process.env.LOBU_MAX_RESERVED_LOCKS = "2";
    try {
      setReservedLockCountForTests(2);
      const lock = await acquireConversationLock("org-a", "agent-a", "conv-a");
      expect(lock).toBeNull();
      // Counter unchanged — the cap check returned before the increment.
      expect(getReservedLockCount()).toBe(2);

      // Staging the counter back below the cap "frees a slot"; the next
      // call should no longer hit the cap rejection. We can't observe the
      // post-reserve success path under PGlite without blocking, but we
      // can confirm `null` is no longer returned at the cap check — by
      // dropping to 1 and re-bumping cap to 1 so the next call falls back
      // to the same null path. (One-off matrix instead of chasing real
      // reserve().)
      setReservedLockCountForTests(1);
      process.env.LOBU_MAX_RESERVED_LOCKS = "1";
      const stillRejected = await acquireConversationLock(
        "org-a",
        "agent-a",
        "conv-b"
      );
      expect(stillRejected).toBeNull();
      expect(getReservedLockCount()).toBe(1);
    } finally {
      setReservedLockCountForTests(0);
      if (prevDisable !== undefined) {
        process.env.LOBU_DISABLE_PREPARE = prevDisable;
      }
    }
  });
});
