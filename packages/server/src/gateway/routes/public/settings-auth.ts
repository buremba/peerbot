import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@lobu/core";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { RevokedTokenStore } from "../../auth/revoked-token-store.js";
import { getRevokedTokenStore } from "../../auth/revoked-token-store.js";
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
let _revokedTokenStore: RevokedTokenStore | null = null;

/**
 * Set a custom auth provider for embedded mode.
 * When set, verifySettingsSession delegates to this provider first,
 * falling back to cookie auth only if it returns null.
 */
export function setAuthProvider(provider: AuthProvider | null): void {
  _authProvider = provider;
}

/**
 * Inject a custom RevokedTokenStore for testing or embedded mode.
 * When null, the process-wide singleton from getRevokedTokenStore() is used.
 */
export function setRevokedTokenStore(store: RevokedTokenStore | null): void {
  _revokedTokenStore = store;
}

function getStore(): RevokedTokenStore {
  return _revokedTokenStore ?? getRevokedTokenStore();
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
 * Returns null if the session's jti has been revoked.
 */
export async function verifySettingsSession(
  c: Context
): Promise<SettingsSession | null> {
  if (_authProvider) {
    const result = _authProvider(c);
    if (result) return result;
  }

  const token = getCookie(c, SETTINGS_SESSION_COOKIE_NAME);
  const session = decodeSettingsPayload(token);
  if (!session) return null;

  if (session.jti && (await getStore().isRevoked(session.jti))) return null;
  return session;
}

/**
 * Verify a standalone encrypted settings token (e.g. from a query param).
 * Returns null if the token's jti has been revoked.
 */
export async function verifySettingsToken(
  token: string | null | undefined
): Promise<SettingsSession | null> {
  if (!token) return null;
  const session = decodeSettingsPayload(token);
  if (!session) return null;

  if (session.jti && (await getStore().isRevoked(session.jti))) return null;
  return session;
}

/**
 * Resolve settings auth from an injected auth provider, cookie session,
 * or a direct encrypted query token.
 */
export async function verifySettingsSessionOrToken(
  c: Context,
  queryKey = "token"
): Promise<SettingsSession | null> {
  return (
    (await verifySettingsSession(c)) ??
    (await verifySettingsToken(c.req.query(queryKey)))
  );
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
