/**
 * Decrypt cookies from a user-owned Chrome profile and inject them into a
 * headless connector subprocess — the "mirror" model. The user picks a
 * Chrome profile in the Lobu menu bar; at sync time we decrypt cookies
 * via the macOS Keychain, drop Google-account domains (to avoid Google's
 * session-conflict logout on the user's real Chrome), and hand a
 * Playwright-ready Cookie[] to the runner. macOS only in v1.
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

export interface DecryptChromeCookiesParams {
  /** "chrome" / "brave" / "arc" / "edge". v1 only honors "chrome". */
  sourceBrowser?: string;
  /** Absolute path to Chrome's user-data root (the dir that contains
   * "Default", "Profile 1", etc. plus Local State). */
  userDataRoot: string;
  /** Subdir name of the source profile, e.g. "Default" or "Profile 1". */
  sourceProfileDir: string;
  /** Optional allow-list of host domains. When set, only cookies whose
   * host_key matches one of these (exact, leading-dot, or wildcard
   * subdomain) are returned. Empty = keep all. Used by `lobu memory
   * browser-auth` to scope captures to a specific connector. */
  allowDomains?: string[];
  /** Optional deny-list of host domains. Cookies whose host_key matches
   * any of these are dropped. Used by mirror mode to skip Google-account
   * cookies (avoids Google's session-conflict logout). */
  denyDomains?: Set<string>;
}

export interface DecryptChromeCookiesResult {
  cookies: Cookie[];
  /** How many cookies decrypted successfully before filtering. */
  total_decrypted: number;
  /** How many cookies got dropped by the deny-list. */
  denied: number;
  /** How many cookies got dropped by the allow-list (or by validation). */
  filtered: number;
}

export interface MirrorCookieAcquireParams {
  sourceBrowser: string;
  userDataRoot: string;
  sourceProfileDir: string;
}

export interface MirrorCookieAcquireResult {
  cookies: Cookie[];
  skipped_google_count: number;
  total_decrypted_count: number;
}

/**
 * Mirror-mode wrapper: decrypt the profile's cookies, filter out the
 * Google-account deny-list. Used by `lobu connector run` so the connector
 * subprocess can run authenticated against a user's Chrome state without
 * launching anything.
 */
export async function acquireMirroredCookies(
  params: MirrorCookieAcquireParams
): Promise<MirrorCookieAcquireResult> {
  const result = await decryptChromeCookiesMacOS({
    sourceBrowser: params.sourceBrowser,
    userDataRoot: params.userDataRoot,
    sourceProfileDir: params.sourceProfileDir,
    denyDomains: new Set(GOOGLE_ACCOUNT_DOMAINS_DENY_LIST),
  });
  sdkLogger.info(
    {
      userDataRoot: params.userDataRoot,
      sourceProfileDir: params.sourceProfileDir,
      totalDecryptedCount: result.total_decrypted,
      skippedGoogleCount: result.denied,
      keptCount: result.cookies.length,
    },
    '[MirrorCookies] Acquired'
  );
  return {
    cookies: result.cookies,
    skipped_google_count: result.denied,
    total_decrypted_count: result.total_decrypted,
  };
}

/**
 * Decrypt cookies from a macOS Chrome profile's SQLite store via the
 * Keychain entry. Generic primitive consumed by both mirror mode (with
 * the Google deny-list) and the CLI's `lobu memory browser-auth` capture
 * flow (with a connector-scoped allow-list). Replaces the older
 * `extractCookiesMacOS` that used to live in
 * `packages/cli/src/commands/memory/_lib/browser-auth-cmd.ts` — that
 * file now imports this.
 */
export async function decryptChromeCookiesMacOS(
  params: DecryptChromeCookiesParams
): Promise<DecryptChromeCookiesResult> {
  if (process.platform !== 'darwin') {
    throw new Error(
      `Mirror cookie acquisition is currently macOS-only (process.platform=${process.platform}). Linux/Windows pending.`
    );
  }
  const cfg = browserConfig(params.sourceBrowser ?? 'chrome');
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
    let totalDecrypted = 0;
    let denied = 0;
    let filtered = 0;
    const chromeEpochOffset = 11644473600n;
    const iv = Buffer.alloc(16, ' ');
    const allowSet = params.allowDomains?.length
      ? buildAllowMatcher(params.allowDomains)
      : null;

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
      totalDecrypted += 1;

      // Deny-list (e.g. Google account domains for mirror mode) wins over
      // allow-list — keeps callers from accidentally allowing something
      // the deny-list intended to skip.
      if (params.denyDomains && matchesDomainSet(row.host_key, params.denyDomains)) {
        denied += 1;
        continue;
      }
      if (allowSet && !allowSet(row.host_key)) {
        filtered += 1;
        continue;
      }

      // Playwright's addCookies is fail-fast on any invalid entry. A
      // handful of cookies decrypt to garbage (pre-M80 layout, legacy
      // v10 variants); reject anything with non-printable bytes since
      // those are clearly metadata leaking through, not a real value.
      if (!row.name || row.name.length === 0) {
        filtered += 1;
        continue;
      }
      if (!row.host_key || row.host_key.length === 0) {
        filtered += 1;
        continue;
      }
      if (!isLikelyCookieValue(value)) {
        filtered += 1;
        continue;
      }
      const cookiePath = row.path && row.path.length > 0 ? row.path : '/';

      const expiresUtc = BigInt(row.expires_utc_text ?? '0');
      const expiresUnix =
        expiresUtc > 0n ? Number(expiresUtc / 1000000n - chromeEpochOffset) : -1;

      // Chrome's `samesite` is -1 (unspecified) | 0 (None) | 1 (Lax) | 2
      // (Strict). Playwright requires exactly one of the three named
      // values; collapse "unspecified" to Lax (the modern Chrome
      // default). "None" requires Secure — promote insecure-None to Lax
      // so the addCookies batch stays valid.
      const sameSite: Cookie['sameSite'] =
        row.samesite === 0 ? 'None' : row.samesite === 2 ? 'Strict' : 'Lax';
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
    return { cookies, total_decrypted: totalDecrypted, denied, filtered };
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

/** Build a host-matching predicate for an allow-list. Mirrors the SQL
 * the old CLI helper used: exact host match, leading-dot variant, or
 * subdomain wildcard. */
function buildAllowMatcher(domains: string[]): (host: string) => boolean {
  const patterns = domains.map((d) => {
    const clean = d.replace(/^\./, '').toLowerCase();
    return { exact: clean, dotted: `.${clean}`, suffix: `.${clean}` };
  });
  return (host: string) => {
    const normalized = host.toLowerCase();
    for (const p of patterns) {
      if (normalized === p.exact) return true;
      if (normalized === p.dotted) return true;
      if (normalized.endsWith(p.suffix)) return true;
    }
    return false;
  };
}

function matchesDomainSet(host: string, deny: Set<string>): boolean {
  const normalized = host.replace(/^\./, '').toLowerCase();
  if (deny.has(normalized)) return true;
  for (const denied of deny) {
    if (normalized.endsWith(`.${denied}`)) return true;
  }
  return false;
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
