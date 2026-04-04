import { decrypt, encrypt } from "@lobu/core";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";

export type AuthProvider = (c: Context) => SettingsTokenPayload | null;

export const SETTINGS_SESSION_COOKIE_NAME = "lobu_settings_session";

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
): SettingsTokenPayload | null {
  if (!token || token.trim().length === 0) return null;

  try {
    const decrypted = decrypt(token);
    const payload = JSON.parse(decrypted) as SettingsTokenPayload;

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
export function verifySettingsSession(c: Context): SettingsTokenPayload | null {
  if (_authProvider) {
    const result = _authProvider(c);
    if (result) return result;
  }

  const token = getCookie(c, SETTINGS_SESSION_COOKIE_NAME);
  return decodeSettingsPayload(token);
}

export function verifySettingsToken(
  token: string | null | undefined
): SettingsTokenPayload | null {
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
): SettingsTokenPayload | null {
  return verifySettingsSession(c) ?? verifySettingsToken(c.req.query(queryKey));
}

/**
 * Set a settings session cookie from a SettingsTokenPayload.
 */
export function setSettingsSessionCookie(
  c: Context,
  session: SettingsTokenPayload
): void {
  const token = encrypt(JSON.stringify(session));
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

export function clearSettingsSessionCookie(c: Context): void {
  deleteCookie(c, SETTINGS_SESSION_COOKIE_NAME, { path: "/" });
}
