/**
 * Worker API trusted-token comparison (#5 — constant-time compare).
 *
 * The trusted-worker auth path grants full cross-org access; the compare must
 * be constant-time (no `===`) and must never throw on a length mismatch.
 */

import { describe, expect, it } from 'vitest';
import { compareWorkerToken } from '../worker-token';

describe('compareWorkerToken', () => {
  const expected = 'lobu_worker_secret_AbCdEf123456';

  it('accepts the exact configured token', () => {
    expect(compareWorkerToken(expected, expected)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = `${expected.slice(0, -1)}X`;
    expect(wrong.length).toBe(expected.length);
    expect(compareWorkerToken(wrong, expected)).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(() =>
      compareWorkerToken(`${expected}-extra`, expected)
    ).not.toThrow();
    expect(compareWorkerToken(`${expected}-extra`, expected)).toBe(false);
    expect(compareWorkerToken(expected.slice(0, 4), expected)).toBe(false);
  });

  it('rejects when the provided token is missing or empty', () => {
    expect(compareWorkerToken(undefined, expected)).toBe(false);
    expect(compareWorkerToken('', expected)).toBe(false);
  });

  it('rejects when the expected token is unconfigured (env unset)', () => {
    // The trusted path is opt-in via WORKER_API_TOKEN — an unset env must never
    // grant trusted access, even against an empty provided token.
    expect(compareWorkerToken('anything', undefined)).toBe(false);
    expect(compareWorkerToken('', undefined)).toBe(false);
    expect(compareWorkerToken(undefined, undefined)).toBe(false);
  });
});
