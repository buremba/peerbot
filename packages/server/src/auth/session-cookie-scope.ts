/**
 * Cookie-scope convergence for the Better Auth session cookie.
 *
 * The same cookie name can exist at two scopes at once — host-only
 * (`app.lobu.ai`) and domain-scoped (`Domain=.lobu.ai`). A browser sends BOTH
 * in one `Cookie` header, the server resolves the FIRST, and RFC 6265 §5.4
 * orders equal-path cookies oldest-first. A stale host-only session cookie is
 * therefore permanently unbeatable: every later sign-in writes a strictly
 * NEWER cookie that can never take precedence, so the user is locked out of
 * the app with no in-app way to recover. Measured on prod 2026-08-06 —
 * `dead; good` resolves to `null` while `good; dead` resolves to the session.
 *
 * Host-only twins are produced by any path that sets the session cookie
 * without the configured zone: the `/exchange-token` and `/local-init` deep
 * links used to, and `document.cookie` planting (see docs/BROWSER_TESTING.md)
 * still can.
 *
 * The cure is to make sign-in authoritative. Whenever a response sets a
 * domain-scoped auth cookie, it also expires the host-only twin of that same
 * name, so a single sign-in collapses the jar back to one cookie — which also
 * self-heals an already-bricked browser on its next sign-in.
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
 * Count how many times `name` appears in a `Cookie` request header.
 *
 * More than one is the brick signature: the request carries the same cookie at
 * two scopes and the loser is invisible to every log we keep. Matching is on
 * the exact name before `=`, so neither a `<name>_other` cookie nor a
 * `__Secure-<name>` cookie is mistaken for `<name>`.
 */
export function countNamedCookies(
	cookieHeader: string | null | undefined,
	name: string,
): number {
	if (!cookieHeader) return 0;
	let count = 0;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) count += 1;
	}
	return count;
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
 */
export function hostOnlyExpiry(name: string, secure: boolean): string {
	const parts = [`${name}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/** True when this `Set-Cookie` is itself a deletion — nothing to converge. */
function isExpiry(setCookie: string): boolean {
	return /;\s*Max-Age=0\b/i.test(setCookie) || /;\s*Expires=Thu, 01 Jan 1970/i.test(setCookie);
}

/**
 * Given the `Set-Cookie` headers a response is about to send, append a
 * host-only expiry for every cookie it sets with a `Domain` attribute.
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
		if (isExpiry(setCookie)) continue;
		expired.add(name);
		// Mirror the source cookie's Secure, not just our own https detection:
		// Better Auth decides `useSecureCookies` from NODE_ENV/configured origin,
		// not from this request's forwarded proto. If it issued a `__Secure-`
		// cookie, an expiry without Secure is silently rejected — the exact
		// no-op this module exists to prevent.
		const secure = opts.isHttps || /;\s*Secure\s*(;|$)/i.test(setCookie);
		out.push(hostOnlyExpiry(name, secure));
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
