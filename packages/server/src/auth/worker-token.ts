import { constantTimeEqual } from '../utils/constant-time-equal';

/**
 * Constant-time comparison of a provided bearer token against the configured
 * `WORKER_API_TOKEN`. The trusted-worker auth path (see `/api/workers/*` in
 * index.ts) grants full cross-org access, so a naive `===` would leak the
 * secret's length and matching prefix via response timing. A missing `expected`
 * (token unconfigured) or `provided` is rejected — the trusted path is opt-in
 * via env, never granted by omission.
 */
export function compareWorkerToken(
  provided: string | undefined,
  expected: string | undefined
): boolean {
  return constantTimeEqual(provided, expected);
}
