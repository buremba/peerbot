import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../utils/logger';

/**
 * Local-install sign-in passcode (the "unlock your own app" gate).
 *
 * In single-user mode the server generates one high-entropy passcode at boot,
 * prints it once to the log (so `lobu run` operators see it in their terminal),
 * and writes it to `<dataDir>/local-passcode` (mode 0600) so the menu bar /
 * other loopback clients can surface it. The web sign-in for a local install
 * asks for this passcode instead of email/password — there is no cloud-style
 * account here, just a process you unlock.
 *
 * Single-process by construction: only embedded single-user installs generate
 * a passcode, so this module-level value is never shared across replicas (the
 * cloud/multi-tenant build never reaches this code; `getLocalPasscode()` stays
 * null there and the SPA falls back to the normal auth form).
 */
let currentPasscode: string | null = null;

/**
 * Generate, persist, and log the local passcode. Idempotent per boot — call
 * once from the pre-listen hook when `LOBU_SINGLE_USER=1`. `dataDir` is the
 * embedded data root (`resolveDataRoot()`); the file lands beside `.lobu/`.
 */
export function generateLocalPasscode(dataDir: string): string {
  // base64url of 24 bytes ≈ 32 chars / ~192 bits — brute force is infeasible,
  // so the passcode's own entropy is the real gate; rate-limiting is just
  // defense-in-depth.
  const code = randomBytes(24).toString('base64url');
  currentPasscode = code;

  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'local-passcode'), `${code}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, '[local-passcode] could not persist passcode file');
  }

  logger.info(
    `[local-passcode] Local sign-in passcode: ${code}  (enter this on the sign-in page)`
  );
  return code;
}

/** The current boot's passcode, or null when this install has none. */
export function getLocalPasscode(): string | null {
  return currentPasscode;
}

/** Constant-time compare of a submitted passcode against the current one. */
export function verifyLocalPasscode(submitted: string): boolean {
  if (!currentPasscode || !submitted) return false;
  const expected = Buffer.from(currentPasscode);
  const got = Buffer.from(submitted);
  // timingSafeEqual throws on length mismatch; bail first (length isn't secret).
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
