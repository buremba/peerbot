/**
 * Regression: `cleanupTestDatabase()`'s whole-DB `TRUNCATE … CASCADE` must
 * survive a deadlock (Postgres `40P01`) with a background DML transaction.
 *
 * The `lobu/scheduled/workspace` bun:test step co-runs many files in ONE
 * process against a SHARED database. Background DB work from one test can
 * outlive it and overlap the NEXT test's `beforeEach` cleanup TRUNCATE.
 *
 * That overlap is a deadlock cycle: TRUNCATE takes `AccessExclusiveLock` on the
 * tables in list order, while a concurrent FK-bearing INSERT takes
 * `RowExclusiveLock` on the child then needs `RowShareLock` on the referenced
 * parent (for example `connections → organization`). Opposite lock-acquire
 * orders → when
 * Postgres aborts OUR `db.begin(…)` TRUNCATE as the victim, the `40P01`
 * propagated out of `cleanupTestDatabase()` and failed whichever test's
 * `beforeEach` ran it (surfaced after #1607 narrowed the catch to rethrow
 * non-`42P01`).
 *
 * These tests drive the helper with a scripted fake `postgres.Sql` to verify
 * error handling and deadlock retry accounting. The real lock-wait semantics
 * are covered in `cleanup-truncate-lock-timeout.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { truncateAllTables } from '../../__tests__/setup/test-db';

type Outcome = '40P01' | '42P01' | '42501' | '55P03' | 'ok';

function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

/**
 * Fake `postgres.Sql` whose every TRUNCATE transaction consumes the next
 * scripted outcome; the last entry repeats.
 */
function fakeDb(script: Outcome[]) {
  let i = 0;
  const consume = () => {
    const outcome = script[Math.min(i, script.length - 1)];
    i++;
    if (outcome !== 'ok') throw pgError(outcome);
  };
  const db = {
    attempts: 0,
    async unsafe(_sql: string) {
      // Diagnostic queries are irrelevant to retry accounting.
    },
    async begin(cb: (tx: { unsafe: (s: string) => Promise<void> }) => Promise<void>) {
      db.attempts++;
      await cb({ unsafe: async () => {} });
      consume();
    },
  };
  return db as typeof db & {
    unsafe: (s: string) => Promise<void>;
    begin: (cb: (tx: { unsafe: (s: string) => Promise<void> }) => Promise<void>) => Promise<void>;
  };
}

describe('truncateAllTables — cleanup error handling', () => {
  test('recovers when the TRUNCATE deadlocks then succeeds on retry', async () => {
    const db = fakeDb(['40P01', '40P01', 'ok']);
    await truncateAllTables(db as any, '"a", "b"', true);
    expect(db.attempts).toBe(3); // two deadlocks + the winning attempt
  });

  test('tolerates 42P01 (a listed table vanished) without throwing', async () => {
    const db = fakeDb(['42P01']);
    await expect(
      truncateAllTables(db as any, '"a"', true)
    ).resolves.toBeUndefined();
    expect(db.attempts).toBe(1);
  });

  test('re-throws an unrelated error immediately (no retry)', async () => {
    const db = fakeDb(['42501', 'ok']);
    await expect(truncateAllTables(db as any, '"a"', true)).rejects.toMatchObject({
      code: '42501',
    });
    expect(db.attempts).toBe(1); // did NOT retry past the first attempt
  });

  test('re-throws the deadlock once retries are exhausted', async () => {
    const db = fakeDb(['40P01']); // deadlocks forever
    await expect(truncateAllTables(db as any, '"a"', true)).rejects.toMatchObject({
      code: '40P01',
    });
    expect(db.attempts).toBeGreaterThan(1); // it really did retry before giving up
  });

  test('reports a lock timeout without retrying the whole transaction', async () => {
    const db = fakeDb(['55P03']);
    await expect(truncateAllTables(db as any, '"a"', true)).rejects.toMatchObject({
      code: '55P03',
    });
    expect(db.attempts).toBe(1);
  });
});
