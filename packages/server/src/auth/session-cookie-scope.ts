/**
 * Cookie-scope convergence for the Better Auth session cookie.
 *
 * The same cookie name can exist at two scopes at once — host-only
 * (`app.lobu.ai`) and domain-scoped (`Domain=.lobu.ai`). A browser sends BOTH
 * in one `Cookie` header, Better Auth reads only the FIRST, and RFC 6265 §5.4
 * orders equal-path cookies oldest-first. A stale host-only session cookie was
 * therefore permanently unbeatable: every later sign-in writes a strictly
 * NEWER cookie that can never take precedence, so the user was locked out of
 * the app with no in-app way to recover. Measured on prod 2026-08-06 —
 * `dead; good` resolved to `null` while `good; dead` resolved to the session.
 *
 * Host-only twins are produced by any path that sets the session cookie
 * without the configured zone: the `/exchange-token` and `/local-init` deep
 * links used to, and `document.cookie` planting (see docs/BROWSER_TESTING.md)
 * still can.
 *
 * Two things answer that, and this module is the second one. `resolveSession`
 * (auth/resolve-session.ts) takes the ordering away from the browser at read
 * time, so a duplicated jar can no longer lock anyone out. This module then
 * collapses the jar: whenever a response sets a domain-scoped auth cookie, it
 * also expires the host-only twin of that same name, so a single sign-in leaves
 * one cookie behind — self-healing a browser that already carries a twin.
 */

/** Better Auth's session cookie name, before the `__Secure-` prefix. */
export const SESSION_COOKIE_BASENAME = "better-auth.session_token";

/**
 * Better Auth adds the `__Secure-` prefix whenever it issues secure cookies
 * (`useSecureCookies` in auth/index.tsx: NODE_ENV production, or an https
 * configured public origin). Derive the name from the resolved public origin —
 * TLS is often terminated by a reverse proxy, so the bind speaking plain HTTP
 * says nothing about the name the browser actually holds.
 */
export function sessionCookieName(isHttps: boolean): string {
	return isHttps ? `__Secure-${SESSION_COOKIE_BASENAME}` : SESSION_COOKIE_BASENAME;
}

/**
 * A `Set-Cookie` value that deletes the HOST-ONLY cookie called `name`.
 *
 * Deliberately carries no `Domain` attribute: cookie deletion matches on
 * (name, domain, path), so omitting Domain targets the host-only twin and
 * leaves the domain-scoped cookie — the one we actually want the browser to
 * keep — untouched. `Secure` is mandatory rather than cosmetic: a browser
 * rejects any `Set-Cookie` for a `__Secure-`-prefixed name that lacks it, so
 * without it the deletion would silently no-op.
 *
 * `path` must mirror the source cookie's own `Path` for the same reason Domain
 * is omitted: deletion matches on (name, domain, path), so an expiry at `/`
 * cannot delete a twin scoped to `/api`. Defaults to `/` — the scope Better
 * Auth issues today — but is passed through rather than assumed.
 */
export function hostOnlyExpiry(name: string, secure: boolean, path = "/"): string {
	const parts = [`${name}=`, `Path=${path}`, "Max-Age=0", "HttpOnly", "SameSite=Lax"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Read the `Path` attribute off a `Set-Cookie`, defaulting to `/`.
 *
 * A cookie sent with no `Path` defaults to the request's directory, which we
 * cannot see from here; `/` is the only safe assumption and is what every
 * cookie this module converges actually carries.
 */
function setCookiePath(setCookie: string): string {
	const match = /;\s*Path=([^;]*)/i.exec(setCookie);
	const path = match?.[1]?.trim();
	return path ? path : "/";
}

/**
 * Given the `Set-Cookie` headers a response is about to send, append a
 * host-only expiry for every cookie it sets with a `Domain` attribute.
 *
 * Deletions are converged too, not skipped. Better Auth's sign-out deletes only
 * the Domain-scoped cookie, and deletion matches on (name, domain, path), so a
 * host-only twin outlives sign-out. Whether that leaves a LIVE session depends
 * on which twin the browser happened to send first — the ordering we do not
 * control — so sign-out could silently leave the user authenticated. Expiring
 * the twin alongside the deletion closes that without cost: an expiry for a
 * cookie the browser does not hold is a no-op.
 *
 * No-ops when no zone is configured: in local dev the host-only cookie IS the
 * real session cookie, and expiring it would log the developer out on sign-in.
 */
export function convergeSetCookieScope(
	setCookies: string[],
	opts: { cookieDomain?: string; isHttps: boolean },
): string[] {
	if (!opts.cookieDomain) return setCookies;

	const out = [...setCookies];
	const expired = new Set<string>();
	for (const setCookie of setCookies) {
		const eq = setCookie.indexOf("=");
		if (eq === -1) continue;
		const name = setCookie.slice(0, eq).trim();
		if (!name || expired.has(name)) continue;
		// Only a domain-scoped Set-Cookie can be shadowed by a host-only twin.
		if (!/;\s*Domain=/i.test(setCookie)) continue;
		expired.add(name);
		// Mirror the source cookie's Secure, not just our own https detection:
		// Better Auth decides `useSecureCookies` from NODE_ENV/configured origin,
		// not from this request's forwarded proto. If it issued a `__Secure-`
		// cookie, an expiry without Secure is silently rejected — the exact
		// no-op this module exists to prevent.
		const secure = opts.isHttps || /;\s*Secure\s*(;|$)/i.test(setCookie);
		out.push(hostOnlyExpiry(name, secure, setCookiePath(setCookie)));
	}
	return out;
}

/**
 * Rewrite a Response's `Set-Cookie` headers in place so every domain-scoped
 * auth cookie it sets also expires its host-only twin.
 *
 * Applied at the `/api/auth/*` chokepoint, this covers every sign-in method at
 * once — Google, Slack, magic link, credential, passkey — plus the `state` and
 * `pkce_code_verifier` cookies, where a shadowed value breaks the OAuth
 * callback rather than the session.
 */
export function convergeResponseCookieScope(
	response: Response,
	opts: { cookieDomain?: string; isHttps: boolean },
): Response {
	if (!opts.cookieDomain) return response;
	const existing = response.headers.getSetCookie();
	if (existing.length === 0) return response;

	const converged = convergeSetCookieScope(existing, opts);
	if (converged.length === existing.length) return response;

	response.headers.delete("set-cookie");
	for (const value of converged) response.headers.append("set-cookie", value);
	return response;
}
