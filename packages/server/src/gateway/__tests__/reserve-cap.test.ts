/**
 * Integration tests for the `acquireConversationLock` reserved-connection
 * cap added in PR #870 (Fix 2). Bound the number of pinned
 * `sql.reserve()` connections per gateway process via
 * `LOBU_MAX_RESERVED_LOCKS` (default derived from `DB_POOL_MAX`) and
 * expose an in-process counter so an operator can observe how close the
 * gateway is to exhausting the postgres-js pool with per-conversation
 * reservations.
 *
 * Validated against the embedded Postgres gateway test harness.
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
} from "../orchestration/deployment-manager.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
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
  // The cap check runs BEFORE any `sql.reserve()`, so these tests stage the
  // in-process counter directly and assert the cap-rejection branch returns
  // `null` without attaching a real connection — backend-agnostic.
  test("cap exhaustion returns null and does not increment the counter", async () => {
    process.env.LOBU_MAX_RESERVED_LOCKS = "0";
    const lock = await acquireConversationLock("org-a", "agent-a", "conv-a");
    expect(lock).toBeNull();
    expect(getReservedLockCount()).toBe(0);
  });

  test("counter helper resets to 0 between tests", () => {
    expect(getReservedLockCount()).toBe(0);
  });

  test("cap rejects when counter has been staged at or above cap", async () => {
    process.env.LOBU_MAX_RESERVED_LOCKS = "2";
    try {
      setReservedLockCountForTests(2);
      const lock = await acquireConversationLock("org-a", "agent-a", "conv-a");
      expect(lock).toBeNull();
      // Counter unchanged — the cap check returned before the increment.
      expect(getReservedLockCount()).toBe(2);

      // Drop below the cap and re-bump the cap to 1 so the next call still
      // hits the cap-rejection branch (counter == cap) — confirms the check
      // tracks the counter without needing a real reserve().
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
    }
  });
});
