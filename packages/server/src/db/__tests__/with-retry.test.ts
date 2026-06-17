import { beforeEach, describe, expect, it, vi } from 'vitest';

// Metrics are a side-effect; mock so the test doesn't depend on the registry
// being initialized and can assert the retry/exhausted counters.
const incrementCounter = vi.fn();
vi.mock('../../gateway/metrics/prometheus', () => ({
  incrementCounter: (...args: unknown[]) => incrementCounter(...args),
}));

import { isTransientDbError, withDbRetry } from '../with-retry';

/** Shapes a postgres.js connection error: `Errors.connection('CONNECTION_ENDED', …)`
 *  stamps the code into `.code` and prefixes the message ("write CONNECTION_ENDED …"). */
function connError(code: string): Error & { code: string } {
  const err = new Error(`write ${code} lobu-ai-prod-db-pooler:5432`) as Error & {
    code: string;
  };
  err.code = code;
  return err;
}

beforeEach(() => {
  incrementCounter.mockClear();
});

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
    expect(incrementCounter).toHaveBeenCalledWith('lobu_db_conn_retry_total', {
      op: 'worker_poll_claim',
      outcome: 'retried',
    });
  });

  it('does NOT retry a non-transient error — fails fast, no extra calls', async () => {
    const dup = new Error('unique_violation') as Error & { code: string };
    dup.code = '23505';
    const fn = vi.fn(async () => {
      throw dup;
    });

    await expect(withDbRetry('worker_poll_claim', fn)).rejects.toBe(dup);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(incrementCounter).not.toHaveBeenCalled();
  });

  it('rethrows and records exhaustion when every attempt drops', async () => {
    const fn = vi.fn(async () => {
      throw connError('CONNECTION_ENDED');
    });

    await expect(withDbRetry('worker_poll_claim', fn)).rejects.toMatchObject({
      code: 'CONNECTION_ENDED',
    });
    expect(fn).toHaveBeenCalledTimes(3); // initial + maxRetries(2)
    expect(incrementCounter).toHaveBeenCalledWith('lobu_db_conn_retry_total', {
      op: 'worker_poll_claim',
      outcome: 'exhausted',
    });
  });
});
