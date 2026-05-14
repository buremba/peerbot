/**
 * Mirror mode: decrypt cookies from a user-owned Chrome profile so the
 * connector subprocess can run authenticated against them in a headless
 * Patchright Chromium, without ever launching the user's actual Chrome
 * (or a Lobu-managed one).
 *
 * Architecture context:
 *   - The user picks one of their installed Chrome profiles in the Lobu
 *     menu bar ("Default", "Profile 1", etc.). The auth_profile row stores
 *     the selection in auth_data.source_profile_dir (e.g. "Default") plus
 *     auth_data.source_browser_root (e.g.
 *     ~/Library/Application Support/Google/Chrome).
 *   - At sync time, the connector subprocess decrypts cookies from
 *     <source_browser_root>/<source_profile_dir>/Cookies via the macOS
 *     keychain entry "Chrome Safe Storage", filters out Google-account
 *     domains (so a Lobu sync can't trigger Google's session-conflict
 *     logout on the user's real Chrome), and returns Cookie[] suitable for
 *     Playwright's BrowserContext.addCookies.
 *   - No Chrome instance is launched as part of this. Patchright in the
 *     connector subprocess starts a fresh headless Chromium, accepts the
 *     injected cookies, and runs.
 *
 * Compared to the earlier "managed Chrome" attempts: no NSWorkspace
 * launching, no TCC keychain dance for Patchright, no Google session
 * conflict — cookies are decrypted in the calling process (which inherits
 * its parent's TCC identity, so the Mac app's "Always Allow" survives),
 * and the Lobu-side Chrome that would have collided with Google never
 * exists.
 *
 * Linux/Windows: this helper currently returns an empty cookie list with
 * a "platform not supported" reason. Their cookie stores aren't keychain-
 * encrypted the same way (Linux uses a fixed `peanuts` constant or
 * libsecret; Windows uses DPAPI), and we wire those paths in a follow-up.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cookie } from 'playwright';
import { sdkLogger } from '../logger.js';

/** Google-account domains we never copy. Two Chrome instances presenting
 * the same Google OAuth cookies trigger Google's session-conflict
 * heuristic, which force-logs out the user's real Chrome. The set covers
 * Google's Sign-In, YouTube, Gmail, and content-CDN auth — enough to keep
 * Lobu-side Chromium out of the Google account entirely. */
const GOOGLE_ACCOUNT_DOMAINS_DENY_LIST = new Set([
  'google.com',
  'accounts.google.com',
  'mail.google.com',
  'gmail.com',
  'youtube.com',
  'googleusercontent.com',
  'googleapis.com',
]);

function isGoogleAccountDomain(host: string): boolean {
  const normalized = host.replace(/^\./, '').toLowerCase();
  if (GOOGLE_ACCOUNT_DOMAINS_DENY_LIST.has(normalized)) return true;
  for (const denied of GOOGLE_ACCOUNT_DOMAINS_DENY_LIST) {
    if (normalized.endsWith(`.${denied}`)) return true;
  }
  return false;
}

/** Map auth_data.source_browser → (Application Support relative path, Keychain service/account).
 * We only fully support Chrome in v1; the others are stubbed for the future
 * but always return null on the keychain lookup path. */
function browserConfig(sourceBrowser: string): {
  userDataRootDefault: string;
  keychain: { service: string; account: string };
} | null {
  switch (sourceBrowser) {
    case 'chrome':
      return {
        userDataRootDefault: 'Google/Chrome',
        keychain: { service: 'Chrome Safe Storage', account: 'Chrome' },
      };
    // Brave / Edge / Arc decryption needs different keychain entries plus
    // version probing — held back until the v1 mirror flow lands.
    default:
      return null;
  }
}

export interface MirrorCookieAcquireParams {
  /** "chrome" / "brave" / "arc" / "edge". v1 only honors "chrome". */
  sourceBrowser: string;
  /** Absolute path to Chrome's user-data root (the dir that contains
   * "Default", "Profile 1", etc. plus Local State). */
  userDataRoot: string;
  /** Subdir name of the source profile, e.g. "Default" or "Profile 1". */
  sourceProfileDir: string;
}

export interface MirrorCookieAcquireResult {
  cookies: Cookie[];
  skipped_google_count: number;
  total_decrypted_count: number;
}

/**
 * Acquire mirrored cookies for the given Chrome profile, with the
 * Google-domain deny list applied. Throws on unsupported platforms /
 * inaccessible keychain.
 */
export async function acquireMirroredCookies(
  params: MirrorCookieAcquireParams
): Promise<MirrorCookieAcquireResult> {
  if (process.platform !== 'darwin') {
    throw new Error(
      `Mirror cookie acquisition is currently macOS-only (process.platform=${process.platform}). Linux/Windows pending.`
    );
  }
  const cfg = browserConfig(params.sourceBrowser);
  if (!cfg) {
    throw new Error(
      `Mirror mode does not yet support source_browser='${params.sourceBrowser}' (v1 is Chrome only).`
    );
  }

  const cookiePath = join(params.userDataRoot, params.sourceProfileDir, 'Cookies');
  if (!existsSync(cookiePath)) {
    throw new Error(
      `Source Chrome profile has no Cookies file at ${cookiePath}. The profile may have been deleted or renamed — re-pick in Lobu.`
    );
  }

  const { pbkdf2Sync, createDecipheriv } = await import('node:crypto');
  // node:sqlite is stable on Node 22+; the lobu repo pins Node 22-24.
  // @types/node 20 doesn't include the typings yet, so the dynamic-import
  // module specifier trips the TS resolver — suppress.
  // @ts-expect-error — node:sqlite typings not in @types/node@20
  const { DatabaseSync } = await import('node:sqlite');

  // Chrome holds a write lock on Cookies; copy to temp so the read can
  // happen safely even while Chrome is running. SQLite WAL mode makes the
  // snapshot consistent.
  const tmpDir = mkdtempSync(join(tmpdir(), 'lobu-mirror-'));
  const tmpCookiePath = join(tmpDir, 'Cookies');
  copyFileSync(cookiePath, tmpCookiePath);
  const journalSrc = join(params.userDataRoot, params.sourceProfileDir, 'Cookies-journal');
  if (existsSync(journalSrc)) {
    copyFileSync(journalSrc, join(tmpDir, 'Cookies-journal'));
  }

  try {
    let keychainKey: string | null = null;
    try {
      keychainKey = execSync(
        `security find-generic-password -w -s "${cfg.keychain.service}" -a "${cfg.keychain.account}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    } catch {
      keychainKey = null;
    }
    if (!keychainKey) {
      throw new Error(
        'Could not read the Chrome encryption key from macOS Keychain. ' +
          'If a system dialog appeared, click "Always Allow" and retry. If no dialog appeared, ' +
          'your Keychain may be locked — run: security unlock-keychain'
      );
    }

    // Chrome's key derivation: PBKDF2(keychainKey, "saltysalt", 1003, 16, sha1).
    const derivedKey = pbkdf2Sync(keychainKey, 'saltysalt', 1003, 16, 'sha1');

    const db = new DatabaseSync(tmpCookiePath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT name, host_key, path, encrypted_value,
                CAST(expires_utc AS TEXT) as expires_utc_text,
                is_httponly, is_secure, samesite
         FROM cookies`
      )
      .all() as Array<{
      name: string;
      host_key: string;
      path: string;
      encrypted_value: Uint8Array;
      expires_utc_text: string | null;
      is_httponly: number;
      is_secure: number;
      samesite: number;
    }>;
    db.close();

    const cookies: Cookie[] = [];
    let skippedGoogleCount = 0;
    let totalDecryptedCount = 0;
    const chromeEpochOffset = 11644473600n;
    const iv = Buffer.alloc(16, ' ');

    for (const row of rows) {
      const raw = row.encrypted_value;
      const encrypted = raw instanceof Buffer ? raw : Buffer.from(raw);
      let value = '';

      if (encrypted.length > 3) {
        const version = encrypted.slice(0, 3).toString('utf-8');
        if (version === 'v10' || version === 'v11') {
          const ciphertext = encrypted.slice(3);
          try {
            const decipher = createDecipheriv('aes-128-cbc', derivedKey, iv);
            const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            value = extractCookieValue(dec);
          } catch {
            continue;
          }
        } else {
          value = encrypted.toString('utf-8');
        }
      }
      if (!value && !row.name) continue;
      totalDecryptedCount += 1;

      if (isGoogleAccountDomain(row.host_key)) {
        skippedGoogleCount += 1;
        continue;
      }

      // Playwright's addCookies is fail-fast on any invalid entry. The
      // user's Chrome contains thousands of cookies and a handful decrypt
      // to garbage (pre-M80 cookies that don't carry the modern 32-byte
      // SHA256(host_key) prefix, or legacy v10 entries with a different
      // layout). Reject anything whose decrypted value has non-printable
      // bytes — those are clearly metadata leaking through, not a real
      // cookie value. We lose maybe 10-20 of 3000+; well below the noise
      // floor.
      if (!row.name || row.name.length === 0) continue;
      if (!row.host_key || row.host_key.length === 0) continue;
      if (!isLikelyCookieValue(value)) continue;
      const cookiePath = row.path && row.path.length > 0 ? row.path : '/';

      const expiresUtc = BigInt(row.expires_utc_text ?? '0');
      const expiresUnix =
        expiresUtc > 0n ? Number(expiresUtc / 1000000n - chromeEpochOffset) : -1;

      // Chrome's `samesite` is -1 (unspecified) | 0 (None) | 1 (Lax) | 2
      // (Strict). Playwright requires exactly one of the three named
      // values, so collapse "unspecified" to Lax (the modern Chrome
      // default for cookies that didn't declare a SameSite attribute).
      const sameSite: Cookie['sameSite'] =
        row.samesite === 0
          ? 'None'
          : row.samesite === 2
            ? 'Strict'
            : 'Lax';

      // Playwright requires "None" cookies to also be Secure. Chrome
      // sometimes stores legacy non-secure SameSite=None cookies; promote
      // them to Lax to keep the batch valid.
      const finalSameSite: Cookie['sameSite'] =
        sameSite === 'None' && row.is_secure !== 1 ? 'Lax' : sameSite;

      cookies.push({
        name: row.name,
        value,
        domain: row.host_key,
        path: cookiePath,
        expires: expiresUnix,
        httpOnly: row.is_httponly === 1,
        secure: row.is_secure === 1,
        sameSite: finalSameSite,
      });
    }

    sdkLogger.info(
      {
        userDataRoot: params.userDataRoot,
        sourceProfileDir: params.sourceProfileDir,
        totalDecryptedCount,
        skippedGoogleCount,
        keptCount: cookies.length,
      },
      '[MirrorCookies] Acquired'
    );
    return {
      cookies,
      skipped_google_count: skippedGoogleCount,
      total_decrypted_count: totalDecryptedCount,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp dir cleanup failure
    }
  }
}

/** Chrome M80+ prepends 32 bytes of SHA256(host_key) to the plaintext
 * before encrypting (per Chromium's `os_crypt_mac.mm`). Slice those off
 * and the remainder is the cookie value, with PKCS#7 padding stripped
 * automatically by Node's `createDecipheriv.final()`. Pre-M80 cookies
 * that lack the prefix decrypt to all-garbage under this slice and get
 * dropped by `isLikelyCookieValue` downstream. */
function extractCookieValue(buf: Buffer): string {
  if (buf.length <= 32) return buf.toString('utf-8');
  return buf.slice(32).toString('utf-8');
}

/** Real cookie values are printable ASCII (the Set-Cookie wire format
 * forbids control characters). Anything else is a decryption artifact
 * we should drop before sending to Playwright. */
function isLikelyCookieValue(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}
