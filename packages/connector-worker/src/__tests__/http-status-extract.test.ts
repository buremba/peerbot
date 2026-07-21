/**
 * Near-end of the connector-side taxonomy pipe (lobu#2051 Item 2): the child
 * runner serializes a thrown error to IPC and must forward a numeric HTTP status
 * (from the SDK's HttpStatusError) so the gateway can classify 429/5xx honestly.
 * This tests that extraction directly — the IPC transport in between is Node's
 * process.send, not our code.
 */

import { describe, expect, test } from 'bun:test';
import { extractHttpStatus } from '../executor/http-status.js';

// Mirror of the SDK's HttpStatusError shape (name + numeric status).
class HttpStatusErrorLike extends Error {
  status: number;
  constructor(status: number) {
    super(`request failed (${status})`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

describe('extractHttpStatus', () => {
  test('pulls the numeric status off an HttpStatusError-shaped error', () => {
    expect(extractHttpStatus(new HttpStatusErrorLike(429))).toBe(429);
    expect(extractHttpStatus(new HttpStatusErrorLike(503))).toBe(503);
    expect(extractHttpStatus(new HttpStatusErrorLike(404))).toBe(404);
  });

  test('reads a plain object carrying status', () => {
    expect(extractHttpStatus({ status: 500 })).toBe(500);
  });

  test('returns undefined when there is no plausible status', () => {
    expect(extractHttpStatus(new Error('boom'))).toBeUndefined();
    expect(extractHttpStatus({ status: 'nope' })).toBeUndefined();
    expect(extractHttpStatus({ status: 42 })).toBeUndefined(); // out of HTTP range
    expect(extractHttpStatus({ status: 700 })).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
    expect(extractHttpStatus(undefined)).toBeUndefined();
    expect(extractHttpStatus('429')).toBeUndefined(); // string, not object
  });
});
