/**
 * Tests for routeAction's error-level classification.
 *
 * ToolUserError is an expected client fault (the REST/MCP layer turns it into a
 * 4xx for the caller). routeAction must log it at `warn`, not `error`, so it
 * stays out of the error log and the pino → Sentry alert feed. Genuine handler
 * faults must still log at `error`.
 *
 * Tested via the exported pure `errorLogLevel` helper rather than by mocking the
 * logger: the integration suite runs with `isolate: false` (shared module
 * registry), so per-file mocks of the already-loaded logger singleton are
 * unreliable.
 */

import { describe, expect, it } from 'vitest';
import { ToolUserError } from '../../../utils/errors';
import { errorLogLevel } from '../action-router';

describe('errorLogLevel', () => {
  it('logs a ToolUserError at warn (any status)', () => {
    expect(errorLogLevel(new ToolUserError('access denied', 403))).toBe('warn');
    expect(errorLogLevel(new ToolUserError('already exists', 409))).toBe('warn');
    expect(errorLogLevel(new ToolUserError('bad input'))).toBe('warn');
  });

  it('logs a genuine Error (and non-Error throwables) at error', () => {
    expect(errorLogLevel(new Error('boom'))).toBe('error');
    expect(errorLogLevel('a thrown string')).toBe('error');
    expect(errorLogLevel(undefined)).toBe('error');
  });
});
