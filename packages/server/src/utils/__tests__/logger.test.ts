/**
 * Tests for the pino → Sentry forwarding guard in utils/logger.ts.
 *
 * Expected client-fault outcomes (ToolUserError / 4xx httpStatus) must NOT be
 * forwarded to Sentry — they are returned to the caller as a 4xx and are not
 * operational alerts. Genuine operational errors must still be captured. This
 * is the path that previously turned routine 409/403 tool outcomes into Sentry
 * issues (LOBU-BACKEND-12, LOBU-BACKEND-Z, LOBU-BACKEND-11).
 *
 * Tested via the exported pure predicate rather than by mocking `@sentry/node`:
 * the integration suite runs with `isolate: false` (shared module registry),
 * so per-file module mocks of an already-loaded singleton are unreliable.
 */

import { describe, expect, it } from 'vitest';
import { isExpectedClientFaultLog } from '../logger';

describe('isExpectedClientFaultLog', () => {
  it('skips a ToolUserError regardless of status', () => {
    expect(isExpectedClientFaultLog({ type: 'ToolUserError', httpStatus: 409 })).toBe(true);
    expect(isExpectedClientFaultLog({ type: 'ToolUserError' })).toBe(true);
  });

  it('skips any 4xx httpStatus (e.g. a 403 thrown as a plain Error)', () => {
    expect(isExpectedClientFaultLog({ type: 'Error', httpStatus: 403 })).toBe(true);
    expect(isExpectedClientFaultLog({ httpStatus: 400 })).toBe(true);
    expect(isExpectedClientFaultLog({ httpStatus: 499 })).toBe(true);
  });

  it('forwards genuine operational errors (no 4xx status, not a ToolUserError)', () => {
    expect(isExpectedClientFaultLog({ type: 'Error', message: 'db boom' })).toBe(false);
    expect(isExpectedClientFaultLog({ type: 'Error', httpStatus: 500 })).toBe(false);
    expect(isExpectedClientFaultLog({ httpStatus: 503 })).toBe(false);
    expect(isExpectedClientFaultLog(undefined)).toBe(false);
  });
});
