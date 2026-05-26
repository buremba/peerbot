import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of a provided bearer token against the configured
 * `WORKER_API_TOKEN`. The trusted-worker auth path (see `/api/workers/*` in
 * index.ts) grants full cross-org access, so a naive `===` would leak the
 * secret's length and matching prefix via response timing.
 *
 * Mirrors the smoke route's `compareTokens`
 * (gateway/routes/internal/smoke.ts): a length-equality pre-check first
 * (`timingSafeEqual` throws on a length mismatch), then the constant-time
 * compare. A missing `expected` (token unconfigured) or `provided` is rejected
 * — the trusted path is opt-in via env, never granted by omission.
 */
export function compareWorkerToken(
  provided: string | undefined,
  expected: string | undefined
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
