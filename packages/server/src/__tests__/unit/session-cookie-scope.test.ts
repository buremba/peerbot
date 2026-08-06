import { describe, expect, test } from "bun:test";
import {
	SESSION_COOKIE_BASENAME,
	convergeSetCookieScope,
	countNamedCookies,
	hostOnlyExpiry,
	sessionCookieName,
} from "../../auth/session-cookie-scope";

/**
 * Regression cover for the permanent-login-brick class.
 *
 * Two cookies can carry the same name at different scopes — host-only
 * (`app.lobu.ai`) and domain-scoped (`Domain=.lobu.ai`). The browser sends
 * BOTH, the server takes the FIRST, and RFC 6265 §5.4 orders equal-path
 * cookies oldest-first. So once a stale host-only session cookie exists, every
 * later sign-in writes a strictly NEWER cookie that can never win, and the
 * user is locked out with no in-app escape — re-logging-in cannot fix it.
 *
 * Measured against prod 2026-08-06 (`/api/auth/get-session`, correctly signed):
 *   good        -> session
 *   dead        -> null
 *   dead; good  -> null      <- the brick
 *   good; dead  -> session
 *
 * The fix makes sign-in authoritative: whenever a response sets a
 * domain-scoped cookie, it must also expire the host-only twin of that name.
 */
describe("session cookie scope convergence", () => {
	test("names the cookie the way Better Auth does", () => {
		expect(sessionCookieName(true)).toBe(`__Secure-${SESSION_COOKIE_BASENAME}`);
		expect(sessionCookieName(false)).toBe(SESSION_COOKIE_BASENAME);
	});

	test("counts duplicate session cookies in a Cookie header (the brick signal)", () => {
		const name = sessionCookieName(true);
		expect(countNamedCookies("", name)).toBe(0);
		expect(countNamedCookies(`${name}=good`, name)).toBe(1);
		expect(countNamedCookies(`${name}=dead; ${name}=good`, name)).toBe(2);
		// A different cookie that merely shares a prefix must not be counted.
		expect(countNamedCookies(`${name}_other=x; ${name}=good`, name)).toBe(1);
		// The unprefixed name must not match the __Secure- variant.
		expect(countNamedCookies(`__Secure-${name}=x`, name)).toBe(0);
	});

	test("builds a host-only expiry that targets the twin, never the domain cookie", () => {
		const header = hostOnlyExpiry(sessionCookieName(true), true);
		expect(header).toMatch(/^__Secure-better-auth\.session_token=;/);
		expect(header).toMatch(/Max-Age=0/);
		expect(header).toMatch(/Path=\//);
		expect(header).toMatch(/Secure/);
		// Load-bearing: no Domain attribute => deletes ONLY the host-only cookie.
		expect(header).not.toMatch(/Domain=/i);
	});

	test("appends a host-only expiry for every domain-scoped cookie it sets", () => {
		const name = sessionCookieName(true);
		const out = convergeSetCookieScope(
			[`${name}=abc.sig; Domain=.lobu.ai; Path=/; HttpOnly; Secure; SameSite=Lax`],
			{ cookieDomain: ".lobu.ai", isHttps: true },
		);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain("Domain=.lobu.ai");
		expect(out[1]).toBe(hostOnlyExpiry(name, true));
	});

	test("covers the OAuth state/pkce cookies too — a shadowed state breaks the callback", () => {
		const out = convergeSetCookieScope(
			[
				"__Secure-better-auth.state=s1; Domain=.lobu.ai; Path=/; HttpOnly; Secure",
				"__Secure-better-auth.pkce_code_verifier=v1; Domain=.lobu.ai; Path=/; HttpOnly; Secure",
			],
			{ cookieDomain: ".lobu.ai", isHttps: true },
		);
		expect(out).toHaveLength(4);
		expect(out.filter((h) => h.includes("Max-Age=0"))).toHaveLength(2);
		expect(out.some((h) => h.startsWith("__Secure-better-auth.state=;"))).toBe(
			true,
		);
		expect(
			out.some((h) => h.startsWith("__Secure-better-auth.pkce_code_verifier=;")),
		).toBe(true);
	});

	test("mirrors the source cookie's Secure even when https detection disagrees", () => {
		// Better Auth keys `useSecureCookies` on NODE_ENV/configured origin, not
		// on this request's forwarded proto. A Secure-less expiry for a
		// `__Secure-` name is silently rejected by the browser — the twin
		// survives and the convergence no-ops.
		const name = sessionCookieName(true);
		const out = convergeSetCookieScope(
			[`${name}=abc.sig; Domain=.lobu.ai; Path=/; HttpOnly; Secure; SameSite=Lax`],
			{ cookieDomain: ".lobu.ai", isHttps: false },
		);
		expect(out).toHaveLength(2);
		expect(out[1]).toMatch(/;\s*Secure$/);
	});

	test("is a no-op with no cookie zone (local dev: host-only IS the real cookie)", () => {
		const name = sessionCookieName(false);
		const set = [`${name}=abc.sig; Path=/; HttpOnly; SameSite=Lax`];
		expect(
			convergeSetCookieScope(set, { cookieDomain: undefined, isHttps: false }),
		).toEqual(set);
	});

	test("never re-expires a cookie the response is already deleting", () => {
		const name = sessionCookieName(true);
		const set = [`${name}=; Domain=.lobu.ai; Path=/; Max-Age=0`];
		expect(
			convergeSetCookieScope(set, { cookieDomain: ".lobu.ai", isHttps: true }),
		).toEqual(set);
	});

	test("leaves host-only Set-Cookies alone (nothing to converge)", () => {
		const set = ["lobu_settings_session=abc; Path=/; HttpOnly; SameSite=Lax"];
		expect(
			convergeSetCookieScope(set, { cookieDomain: ".lobu.ai", isHttps: true }),
		).toEqual(set);
	});
});
