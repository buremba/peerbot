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

import { describe, expect, it, vi } from 'vitest';
import logger, { isExpectedClientFaultLog } from '../logger';

describe('HTTP secret redaction', () => {
  it('redacts credentials from request and response headers', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';

    try {
      logger.info(
        {
          req: {
            headers: {
              authorization: 'Bearer request-secret',
              cookie: 'session=request-cookie',
              'proxy-authorization': 'Basic proxy-secret',
              'x-api-key': 'api-key-secret',
            },
          },
          res: {
            headers: {
              'set-cookie': 'session=response-cookie',
            },
          },
        },
        'request completed',
      );
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      write.mockRestore();
    }

    expect(output).toContain('request completed');
    expect(output).not.toContain('request-secret');
    expect(output).not.toContain('request-cookie');
    expect(output).not.toContain('proxy-secret');
    expect(output).not.toContain('api-key-secret');
    expect(output).not.toContain('response-cookie');
    expect(output).toContain('[redacted]');
  });
});

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
