import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for secrets (bearer tokens, deployment names,
 * token digests). A naive `===` short-circuits on the first differing byte,
 * leaking the secret's length and matching prefix through response timing.
 *
 * - A missing `a` or `b` is rejected — secret comparisons are opt-in, never
 *   satisfied by an unconfigured/absent value.
 * - A length mismatch returns false WITHOUT calling `timingSafeEqual` (which
 *   throws on unequal-length buffers). This does reveal length inequality, which
 *   is acceptable: the inputs that gate real secrets are either fixed-length
 *   digests or fixed-length tokens. When comparing variable-length inputs whose
 *   length must stay secret, hash both to a fixed-length digest first and pass
 *   the digests here.
 */
export function constantTimeEqual(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
