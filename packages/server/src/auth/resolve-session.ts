/**
 * Session resolution that does not depend on cookie order.
 *
 * The same auth cookie name can exist at two scopes at once — host-only
 * (`app.lobu.ai`) and domain-scoped (`Domain=.lobu.ai`) — and a browser sends
 * BOTH in one `Cookie` header. Which one authenticates is then decided purely
 * by position, and the position is not ours to choose:
 *
 *   RFC 6265 §5.4  browser sends equal-path cookies oldest-first
 *   better-call    parseCookies keeps the FIRST occurrence (`if (!cookies.has(key))`)
 *   better-auth    getSignedCookie reads that one and stops
 *
 * So a stale twin that happens to be older silently outranks the real session.
 * The user is locked out with no in-app escape, because signing in again always
 * writes the NEWER cookie — the one that can never win. Measured on prod
 * 2026-08-06: `dead; good` resolved to null, `good; dead` resolved to the
 * session. Identical cookies; only the order differed.
 *
 * `resolveSession` removes the ambiguity at the point of use: with one cookie it
 * is exactly `getSession`, and with several it asks about each in isolation and
 * takes the one that actually verifies. Possession of a live session token is
 * what authenticates — never its position in the jar.
 */

/** Better Auth's session cookie, bare and with the `__Secure-` prefix. */
const SESSION_COOKIE_BASENAME = 'better-auth.session_token';
const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_BASENAME,
  `__Secure-${SESSION_COOKIE_BASENAME}`,
];

/**
 * The minimum of Better Auth's surface this module needs. Deliberately generic:
 * the return type is inferred from the caller's own `auth`, so wrapping
 * `getSession` never widens what a call site sees.
 */
type SessionReader = {
  api: { getSession: (opts: { headers: Headers }) => Promise<any> };
};
type SessionOf<A extends SessionReader> = Awaited<ReturnType<A['api']['getSession']>>;

/**
 * Every session-cookie value in a `Cookie` header, in the order sent.
 *
 * Values come back raw — only `getSession` can say which of them verify.
 * Matching is on the exact name before `=`, so a `<name>_other` cookie is never
 * mistaken for `<name>`.
 */
export function sessionCookieCandidates(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (!SESSION_COOKIE_NAMES.includes(part.slice(0, eq).trim())) continue;
    const value = part.slice(eq + 1).trim();
    if (value) values.push(value);
  }
  return values;
}

/** A session object Better Auth considers authenticated. */
function isLive(session: any): boolean {
  return Boolean(session?.user && session.session);
}

/**
 * Resolve the request's session without letting cookie order decide it.
 *
 * Drop-in for `auth.api.getSession({ headers })`. The single-cookie path — every
 * ordinary request — is byte-for-byte the old behaviour and costs nothing extra;
 * the extra lookups happen only for a jar that is already broken.
 *
 * Note the candidate header keeps every other header intact and rewrites only
 * `Cookie`, so `Authorization: Bearer` and origin checks behave as before.
 */
export async function resolveSession<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<SessionOf<A>> {
  const candidates = sessionCookieCandidates(headers.get('cookie'));
  if (candidates.length <= 1) return await auth.api.getSession({ headers });

  for (const candidate of candidates) {
    const single = new Headers(headers);
    single.set('cookie', `${SESSION_COOKIE_BASENAME}=${candidate}`);
    const session = await auth.api.getSession({ headers: single });
    if (isLive(session)) return session;
  }
  // Every candidate was dead. Resolving on merit must not become "authenticate
  // on anything" — an ambiguous jar with no live token is still no session.
  return null as SessionOf<A>;
}
