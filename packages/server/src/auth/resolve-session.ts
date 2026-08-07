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

import { sessionCookieName } from './session-cookie-scope';

/**
 * Both spellings can be present at once: Better Auth adds the `__Secure-`
 * prefix only when issuing secure cookies, and a jar can outlive that switch.
 */
const SESSION_COOKIE_NAMES = [sessionCookieName(false), sessionCookieName(true)];

/**
 * How many candidates one request may cost us.
 *
 * `Cookie` is attacker-controlled and each probe is a session lookup, so an
 * unbounded loop turns one unauthenticated request into ~100 of them. A real
 * jar holds a twin or two (host-only, domain, occasionally a parent domain, and
 * at most one leftover of the other spelling), so this is far above anything a
 * browser produces and still bounds the cost.
 */
const MAX_CANDIDATES = 8;

/** One session cookie as the jar carries it: its exact name and raw value. */
type SessionCookieCandidate = { name: string; value: string };

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
 * Every session cookie in a `Cookie` header, in the order sent.
 *
 * Each candidate keeps the name it arrived under, because that name is what
 * decides whether Better Auth can see it at all: `getSession` reads exactly one
 * name, the one `useSecureCookies` derives, and is blind to the other spelling.
 *
 * Values come back raw — only `getSession` can say which of them verify.
 * Matching is on the exact name before `=`, so a `<name>_other` cookie is never
 * mistaken for `<name>`.
 */
export function sessionCookieCandidates(
  cookieHeader: string | null | undefined
): SessionCookieCandidate[] {
  if (!cookieHeader) return [];
  const candidates: SessionCookieCandidate[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!SESSION_COOKIE_NAMES.includes(name)) continue;
    const value = part.slice(eq + 1).trim();
    if (value) candidates.push({ name, value });
  }
  return candidates;
}

/**
 * A session object that authenticates someone.
 *
 * The predicate is `user`, not `user && session`, because `user` is the weakest
 * thing any caller requires — `auth/middleware.ts`, `auth/oauth/routes.ts`,
 * `connect/routes.ts` and `worker-api/auth-runs.ts` all check `session?.user`
 * alone. Demanding more here would reject, on a duplicated jar, a session those
 * callers accept on a clean one. A dead cookie yields `null` either way, so this
 * costs nothing in candidate selection.
 */
function isLive(session: any): boolean {
  return Boolean(session?.user);
}

/**
 * The jar minus its session cookies — everything a probe must carry unchanged.
 *
 * Better Auth reads companions alongside the session token, and they change how
 * `getSession` behaves: `better-auth.dont_remember` gates session-expiry
 * refresh, and `better-auth.session_data` is its cookie cache. Dropping the
 * whole header would give a duplicated jar different refresh semantics from a
 * clean one — a difference that has nothing to do with which twin is live.
 */
function nonSessionCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const kept: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (SESSION_COOKIE_NAMES.includes(pair.slice(0, eq).trim())) continue;
    kept.push(pair);
  }
  return kept;
}

/**
 * Resolve the request's session without letting cookie order decide it.
 *
 * Drop-in for `auth.api.getSession({ headers })`. The single-cookie path — every
 * ordinary request — is byte-for-byte the old behaviour and costs nothing extra;
 * the extra lookups happen only for a jar that is already broken.
 *
 * A probe changes exactly one thing: which session cookie is in the jar. Every
 * other header survives, so `Authorization: Bearer` and origin checks behave as
 * before; every non-session cookie survives, so Better Auth's companions still
 * apply; and the candidate keeps the name it arrived under, because renaming it
 * would hide it from `getSession` entirely.
 */
export async function resolveSession<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<SessionOf<A>> {
  const live = await findLiveProbe(auth, headers);
  if (!live) return await auth.api.getSession({ headers });
  // Every candidate was dead. Resolving on merit must not become "authenticate
  // on anything" — an ambiguous jar with no live token is still no session.
  return (live.session ?? null) as SessionOf<A>;
}

/**
 * Probe an ambiguous jar one candidate at a time, and report what verified.
 *
 * `null` means the jar was not ambiguous — one session cookie or none — so the
 * caller should just use the headers it already has. Otherwise the result
 * carries the probe headers and the session they produced, and `session` is
 * `null` when no candidate verified. Returning both means the winning lookup is
 * never repeated.
 */
async function findLiveProbe<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<{ headers: Headers; session: SessionOf<A> | null } | null> {
  const cookieHeader = headers.get('cookie');
  const candidates = sessionCookieCandidates(cookieHeader);
  if (candidates.length <= 1) return null;

  const companions = nonSessionCookies(cookieHeader);
  let last = headers;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const probe = new Headers(headers);
    probe.set(
      'cookie',
      [...companions, `${candidate.name}=${candidate.value}`].join('; ')
    );
    last = probe;
    const session = await auth.api.getSession({ headers: probe });
    if (isLive(session)) return { headers: probe, session };
  }
  return { headers: last, session: null };
}

/**
 * Headers with the ambiguity already removed — the jar reduced to its live
 * session cookie, or to none if no candidate verifies.
 *
 * `resolveSession` is for code that wants the session. This is for code that
 * must hand the request to someone else who will resolve it themselves — namely
 * Better Auth's own `/api/auth/*` handler, which reads the raw jar and would
 * otherwise take the first cookie and answer `null` for a bricked browser. That
 * endpoint is how the web app asks "am I signed in", so leaving it order-
 * dependent would keep the brick visible in the UI even with every internal
 * call site fixed.
 *
 * Returns `headers` unchanged for an ordinary jar, so the common path is free.
 */
export async function collapseSessionCookies<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<Headers> {
  const live = await findLiveProbe(auth, headers);
  if (!live) return headers;
  if (live.session) return live.headers;

  // No candidate verifies. Send the jar with no session cookie at all rather
  // than an arbitrary dead one: "not signed in" is the honest answer, and it
  // keeps sign-in and sign-out on this request from acting on a dead twin.
  const companions = nonSessionCookies(headers.get('cookie'));
  const stripped = new Headers(headers);
  if (companions.length > 0) stripped.set('cookie', companions.join('; '));
  else stripped.delete('cookie');
  return stripped;
}
