import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@lobu/core";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";

/**
 * Settings session payload as carried in the encrypted cookie/token: the
 * base payload plus a random `jti` minted at issue time so a leaked cookie
 * can be revoked via the `revoked_tokens` store.
 */
export type SettingsSession = SettingsTokenPayload & { jti?: string };

export type AuthProvider = (c: Context) => SettingsSession | null;

const SETTINGS_SESSION_COOKIE_NAME = "lobu_settings_session";

let _authProvider: AuthProvider | null = null;

/**
 * Set a custom auth provider for embedded mode.
 * When set, verifySettingsSession delegates to this provider first,
 * falling back to cookie auth only if it returns null.
 */
export function setAuthProvider(provider: AuthProvider | null): void {
  _authProvider = provider;
}

function decodeSettingsPayload(
  token: string | null | undefined
): SettingsSession | null {
  if (!token || token.trim().length === 0) return null;

  try {
    const decrypted = decrypt(token);
    const payload = JSON.parse(decrypted) as SettingsSession;

    if (!payload.userId || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

function isSecureRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

/**
 * Verify settings session.
 * Checks injected auth provider first (for embedded mode),
 * then falls back to cookie-based session auth.
 */
export function verifySettingsSession(c: Context): SettingsSession | null {
  if (_authProvider) {
    const result = _authProvider(c);
    if (result) return result;
  }

  const token = getCookie(c, SETTINGS_SESSION_COOKIE_NAME);
  return decodeSettingsPayload(token);
}

export function verifySettingsToken(
  token: string | null | undefined
): SettingsSession | null {
  if (!token) return null;
  return decodeSettingsPayload(token);
}

/**
 * Resolve settings auth from an injected auth provider, cookie session,
 * or a direct encrypted query token.
 */
export function verifySettingsSessionOrToken(
  c: Context,
  queryKey = "token"
): SettingsSession | null {
  return verifySettingsSession(c) ?? verifySettingsToken(c.req.query(queryKey));
}

/**
 * Set a settings session cookie from a SettingsTokenPayload. A random `jti`
 * is minted here when the payload doesn't already carry one, so the issued
 * cookie can be killed via the `revoked_tokens` store before it expires.
 */
export function setSettingsSessionCookie(
  c: Context,
  session: SettingsTokenPayload
): void {
  const withJti: SettingsSession = {
    ...session,
    jti: (session as SettingsSession).jti ?? randomUUID(),
  };
  const token = encrypt(JSON.stringify(withJti));
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((session.exp - Date.now()) / 1000)
  );

  setCookie(c, SETTINGS_SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    maxAge: maxAgeSeconds,
  });
}
