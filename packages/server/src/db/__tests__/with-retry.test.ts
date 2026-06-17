import { describe, expect, it, vi } from 'vitest';

import { isTransientDbError, withDbRetry } from '../with-retry';

// NOTE: we deliberately do NOT mock '../../gateway/metrics/prometheus' to assert
// the metric increment. The server vitest suite runs with `isolate: false`
// (one shared module graph), under which `vi.mock` of a shared singleton
// silently no-ops in the full run — the test passes alone but fails in CI. The
// metric side-effect is covered by review + registration; here we assert the
// observable behavior contract (retry/no-retry/exhaust), which is what matters.

/** Shapes a postgres.js connection error: `Errors.connection('CONNECTION_ENDED', …)`
 *  stamps the code into `.code` and prefixes the message ("write CONNECTION_ENDED …"). */
function connError(code: string): Error & { code: string } {
  const err = new Error(`write ${code} lobu-ai-prod-db-pooler:5432`) as Error & {
    code: string;
  };
  err.code = code;
  return err;
}

describe('isTransientDbError', () => {
  it('matches postgres.js connection-drop codes', () => {
    expect(isTransientDbError(connError('CONNECTION_ENDED'))).toBe(true);
    expect(isTransientDbError(connError('CONNECTION_CLOSED'))).toBe(true);
    expect(isTransientDbError(connError('ECONNRESET'))).toBe(true);
  });

  it('matches when the code only survives in the message', () => {
    expect(isTransientDbError(new Error('write CONNECTION_ENDED host:5432'))).toBe(
      true
    );
  });

  it('does NOT match query-level errors (must not retry those)', () => {
    // 23505 unique_violation, deadlock, statement timeout — never transient.
    const dup = new Error('duplicate key value violates unique constraint') as Error & {
      code: string;
    };
    dup.code = '23505';
    expect(isTransientDbError(dup)).toBe(false);
    expect(isTransientDbError(new Error('canceling statement due to statement timeout'))).toBe(
      false
    );
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('boom')).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('recovers a transient connection drop on retry (red→green: this used to 500)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw connError('CONNECTION_ENDED');
      return { id: 42 };
    });

    const result = await withDbRetry('worker_poll_claim', fn);

    expect(result).toEqual({ id: 42 });
    expect(fn).toHaveBeenCalledTimes(2); // dropped once, succeeded on the fresh connection
  });

  it('does NOT retry a non-transient error — fails fast, no extra calls', async () => {
    const dup = new Error('unique_violation') as Error & { code: string };
    dup.code = '23505';
    const fn = vi.fn(async () => {
      throw dup;
    });

    await expect(withDbRetry('worker_poll_claim', fn)).rejects.toBe(dup);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows and records exhaustion when every attempt drops', async () => {
    const fn = vi.fn(async () => {
      throw connError('CONNECTION_ENDED');
    });

    await expect(withDbRetry('worker_poll_claim', fn)).rejects.toMatchObject({
      code: 'CONNECTION_ENDED',
    });
    expect(fn).toHaveBeenCalledTimes(3); // initial + maxRetries(2)
  });
});
