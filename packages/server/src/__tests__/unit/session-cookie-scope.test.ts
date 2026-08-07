import { describe, expect, test } from "bun:test";
import {
	SESSION_COOKIE_BASENAME,
	convergeResponseCookieScope,
	convergeSetCookieScope,
	countNamedCookies,
	hostOnlyExpiry,
	sessionCookieName,
} from "../../auth/session-cookie-scope";

/**
 * Regression cover for the permanent-login-brick class.
 * Mechanism and cure: ../../auth/session-cookie-scope.ts.
 *
 * The measurement that pinned it, prod 2026-08-06 (`/api/auth/get-session`,
 * correctly signed cookies) — order is the ONLY difference between rows 3 and 4:
 *   good        -> session
 *   dead        -> null
 *   dead; good  -> null      <- the brick
 *   good; dead  -> session
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

	test("expires the twin on sign-out too, or sign-out leaves a live session", () => {
		// Better Auth's sign-out deletes ONLY the Domain-scoped cookie. Deletion
		// matches on (name, domain, path), so the host-only twin survives. Which
		// of the two the server resolved is decided by the browser's send order,
		// which we do not control — so skipping deletions can leave the user
		// signed in after sign-out. Converging costs nothing: an expiry for a
		// cookie the browser does not hold is a no-op.
		const name = sessionCookieName(true);
		const set = [`${name}=; Domain=.lobu.ai; Path=/; Max-Age=0; Secure`];
		const out = convergeSetCookieScope(set, {
			cookieDomain: ".lobu.ai",
			isHttps: true,
		});
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(set[0]);
		expect(out[1]).toBe(hostOnlyExpiry(name, true));
	});

	test("leaves host-only Set-Cookies alone (nothing to converge)", () => {
		const set = ["lobu_settings_session=abc; Path=/; HttpOnly; SameSite=Lax"];
		expect(
			convergeSetCookieScope(set, { cookieDomain: ".lobu.ai", isHttps: true }),
		).toEqual(set);
	});

	test("expires the twin at the source cookie's Path, not a hardcoded /", () => {
		// Deletion matches on (name, domain, path). An expiry at `/` cannot
		// delete a twin scoped to `/api`, so the convergence would silently
		// no-op — the exact failure this module exists to prevent.
		const name = sessionCookieName(true);
		const out = convergeSetCookieScope(
			[`${name}=abc.sig; Domain=.lobu.ai; Path=/api; HttpOnly; Secure`],
			{ cookieDomain: ".lobu.ai", isHttps: true },
		);
		expect(out).toHaveLength(2);
		expect(out[1]).toContain("Path=/api");
		expect(out[1]).not.toContain("Path=/;");
	});
});

/**
 * `convergeResponseCookieScope` is the `/api/auth/*` chokepoint wrapper, so it
 * is the highest-blast-radius path in this module: every sign-in method routes
 * through it. It mutates a real `Response`'s headers by delete-then-re-append,
 * which is only safe because better-call always builds responses with
 * `new Response(...)` (a `Response.redirect` has immutable headers and would
 * throw). These tests pin that the mutation preserves everything else.
 */
describe("convergeResponseCookieScope", () => {
	const name = sessionCookieName(true);
	const domainCookie = `${name}=abc.sig; Domain=.lobu.ai; Path=/; HttpOnly; Secure; SameSite=Lax`;
	const hostOnlyCookie = "lobu_other=keep; Path=/; HttpOnly; SameSite=Lax";

	function redirectWithCookies(...cookies: string[]): Response {
		const res = new Response(null, {
			status: 302,
			headers: { Location: "/" },
		});
		for (const c of cookies) res.headers.append("set-cookie", c);
		return res;
	}

	test("appends the twin expiry and leaves status, Location and other cookies intact", () => {
		const res = convergeResponseCookieScope(
			redirectWithCookies(domainCookie, hostOnlyCookie),
			{ cookieDomain: ".lobu.ai", isHttps: true },
		);

		const set = res.headers.getSetCookie();
		expect(set).toHaveLength(3);
		expect(set[0]).toBe(domainCookie);
		// The host-only cookie is not domain-scoped, so it must survive verbatim.
		expect(set[1]).toBe(hostOnlyCookie);
		expect(set[2]).toBe(hostOnlyExpiry(name, true));

		// The delete/re-append must not disturb the rest of the response.
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/");
	});

	test("is a no-op with no cookie zone configured", () => {
		const res = redirectWithCookies(domainCookie);
		const out = convergeResponseCookieScope(res, {
			cookieDomain: undefined,
			isHttps: true,
		});
		expect(out.headers.getSetCookie()).toEqual([domainCookie]);
	});

	test("is a no-op when the response sets no cookies at all", () => {
		const res = new Response(null, { status: 302, headers: { Location: "/" } });
		const out = convergeResponseCookieScope(res, {
			cookieDomain: ".lobu.ai",
			isHttps: true,
		});
		expect(out.headers.getSetCookie()).toHaveLength(0);
		expect(out.headers.get("Location")).toBe("/");
	});

	test("leaves the headers untouched when nothing needs converging", () => {
		const res = redirectWithCookies(hostOnlyCookie);
		const out = convergeResponseCookieScope(res, {
			cookieDomain: ".lobu.ai",
			isHttps: true,
		});
		expect(out.headers.getSetCookie()).toEqual([hostOnlyCookie]);
	});
});
