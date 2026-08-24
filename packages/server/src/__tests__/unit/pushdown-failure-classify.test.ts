/**
 * Far-end of the connector-side taxonomy pipe (lobu#2051 Item 2): when a connector
 * subprocess fails, query_sql re-throws with a code derived from the structured
 * `httpStatus` the executor propagates (from the SDK's HttpStatusError) — not from
 * keyword-matching the redacted message. This pins that classification.
 *
 * `classifyPushdownFailure` is the exact function query_sql's 502 throw sites call.
 */

import { describe, expect, it } from 'bun:test';
import { isRetryable } from '@lobu/core';
import { classifyPushdownFailure } from '../../lib/connector-pushdown';

// Mirror of SubprocessError's surface: a message plus the propagated httpStatus.
class SubprocessErrorLike extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'SubprocessError';
    this.httpStatus = httpStatus;
  }
}

describe('classifyPushdownFailure', () => {
  it('classifies a propagated 429 as RATE_LIMITED (retryable)', () => {
    const code = classifyPushdownFailure(new SubprocessErrorLike('redacted', 429));
    expect(code).toBe('RATE_LIMITED');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a propagated 503 as UPSTREAM_5XX (retryable)', () => {
    const code = classifyPushdownFailure(new SubprocessErrorLike('redacted', 503));
    expect(code).toBe('UPSTREAM_5XX');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a propagated 404 as NOT_FOUND (not retryable)', () => {
    const code = classifyPushdownFailure(new SubprocessErrorLike('redacted', 404));
    expect(code).toBe('NOT_FOUND');
    expect(isRetryable(code)).toBe(false);
  });

  it('prefers the structured status over a misleading message', () => {
    // Message contains "timeout" (would keyword-match) but the real status is 429.
    const code = classifyPushdownFailure(
      new SubprocessErrorLike('connection timeout while fetching', 429)
    );
    expect(code).toBe('RATE_LIMITED');
  });

  it('falls back to UPSTREAM_5XX for an opaque failure with no status', () => {
    // A broken feed/connector with no HTTP status and an unclassifiable message:
    // default to a retryable server-side error rather than INTERNAL.
    const code = classifyPushdownFailure(new SubprocessErrorLike('feed exploded', undefined));
    expect(code).toBe('UPSTREAM_5XX');
  });

  it('still keyword-classifies a transient message when no status is present', () => {
    const code = classifyPushdownFailure(new SubprocessErrorLike('ECONNRESET', undefined));
    expect(code).toBe('NETWORK');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a structured subprocess deadline as UPSTREAM_TIMEOUT', () => {
    const error = Object.assign(new Error('redacted'), { exitReason: 'timeout' });
    const code = classifyPushdownFailure(error);
    expect(code).toBe('UPSTREAM_TIMEOUT');
    expect(isRetryable(code)).toBe(true);
  });
});
