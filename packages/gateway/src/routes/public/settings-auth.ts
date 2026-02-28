import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  type SettingsTokenPayload,
  verifySettingsToken,
} from "../../auth/settings/token-service";

export const SETTINGS_TOKEN_QUERY_PARAM = "token";
export const SETTINGS_SESSION_COOKIE_NAME = "lobu_settings_session";

function getTokenFromQuery(c: Context): string | undefined {
  const token = c.req.query(SETTINGS_TOKEN_QUERY_PARAM);
  if (!token || token.trim().length === 0) return undefined;
  return token;
}

function getTokenFromCookie(c: Context): string | undefined {
  const token = getCookie(c, SETTINGS_SESSION_COOKIE_NAME);
  if (!token || token.trim().length === 0) return undefined;
  return token;
}

function isSecureRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

export function resolveSettingsToken(c: Context): string | undefined {
  return getTokenFromQuery(c) ?? getTokenFromCookie(c);
}

export function verifySettingsSession(c: Context): SettingsTokenPayload | null {
  const token = resolveSettingsToken(c);
  if (!token) return null;
  return verifySettingsToken(token);
}

export function setSettingsSessionCookie(
  c: Context,
  token: string,
  payload?: SettingsTokenPayload
): boolean {
  const verifiedPayload = payload ?? verifySettingsToken(token);
  if (!verifiedPayload) return false;

  const maxAgeSeconds = Math.max(
    1,
    Math.floor((verifiedPayload.exp - Date.now()) / 1000)
  );

  setCookie(c, SETTINGS_SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    maxAge: maxAgeSeconds,
  });

  return true;
}

export function clearSettingsSessionCookie(c: Context): void {
  deleteCookie(c, SETTINGS_SESSION_COOKIE_NAME, { path: "/" });
}
