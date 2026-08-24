import { getConfiguredPublicOrigin, getSubdomainZone } from "./public-origin";

/** Env bindings this boundary reads. `Env` and `process.env` both satisfy it. */
type CorsEnv = Record<string, string | undefined>;

const LOCALHOST_HOSTNAMES = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
]);

// Owned Owletto for Chrome extension IDs. Identity for CSP frame-ancestors
// AND CORS — both have to agree that an extension is "us", otherwise either
// iframe embedding or fetch-from-SW breaks. There are two distinct IDs and
// both are production facts, so both are pinned here:
//   - DEV/UNPACKED: derived from the manifest `key` field (see
//     lobu-ai/owletto:apps/chrome/manifest.json). This is the ID our local
//     harness and any unpacked build loads as.
//   - PUBLISHED: assigned by the Chrome Web Store, which overrides the
//     manifest `key` with its own signing key, so the store build runs under
//     a different ID (see lobu-ai/owletto:store-assets/STORE-LISTING.md and
//     apps/mac/Owletto/OwlettoApp.swift). The store ID was previously missing
//     from this list, so app.lobu.ai's frame-ancestors blocked the published
//     sidepanel iframe even though local dev worked.
const OWLETTO_EXTENSION_IDS = [
	"amnnhclgmbldmfcfamonoggjhfidemmm", // dev/unpacked (manifest `key`)
	"jhgcecbdpnoehfnhpdfihlchjddapepi", // Chrome Web Store (published)
] as const;

const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Owned Owletto extension IDs (the pinned dev + published IDs, plus anything
 * pinned via LOBU_OWLETTO_EXTENSION_IDS for an ad-hoc signed build). This is
 * shared by CSP and both CORS middleware instances so those boundaries cannot
 * drift apart.
 */
export function getOwnedOwlettoExtensionIds(env: CorsEnv): string[] {
	const extra = (env.LOBU_OWLETTO_EXTENSION_IDS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => CHROME_EXTENSION_ID_RE.test(value));
	return [...OWLETTO_EXTENSION_IDS, ...extra];
}

function getExplicitAllowedOrigins(raw: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const value of raw?.split(",") ?? []) {
		const candidate = value.trim();
		if (!candidate) continue;
		try {
			const parsed = new URL(candidate);
			// `file:`/`data:`/`chrome-extension:` entries all serialize to the
			// opaque origin "null"; storing that would match any other opaque
			// origin, so drop them rather than collapse distinct origins into one.
			if (parsed.origin !== "null") origins.add(parsed.origin);
		} catch {
			// Ignore malformed operator entries instead of widening CORS.
		}
	}
	return origins;
}

/**
 * Shared browser-origin trust boundary for both the main app and the embedded
 * Agent API mounted at `/lobu`.
 *
 * CORS is transport permission, not tenant authorization. Approved requests
 * still pass through Better Auth plus the Agent API's ownership/membership
 * checks. The configured cookie zone is the authority for sibling workspace
 * hosts; never infer a registrable domain from the request hostname.
 */
export function isAllowedCorsOrigin(
	origin: string,
	env: CorsEnv,
	requestUrl: string,
	options: { allowConfiguredOrigins?: boolean } = {},
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}

	// The Owletto extension's service worker fetches /api/workers/poll as
	// origin chrome-extension://<id>. Match against the same owned-IDs list
	// the CSP block uses so the two trust boundaries can't drift.
	if (parsed.protocol === "chrome-extension:") {
		const owned = new Set(getOwnedOwlettoExtensionIds(env));
		return owned.has(parsed.hostname);
	}

	if (LOCALHOST_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
		return true;
	}

	if (
		options.allowConfiguredOrigins &&
		getExplicitAllowedOrigins(env.ALLOWED_ORIGINS).has(parsed.origin)
	) {
		return true;
	}

	// Behind a TLS-terminating proxy, requestUrl may be http://. The configured
	// public origin remains the source of truth for the canonical https origin.
	const canonicalOrigin =
		getConfiguredPublicOrigin() ?? new URL(requestUrl).origin;
	if (parsed.origin === canonicalOrigin) return true;

	// Allow wildcard subdomains of the canonical origin (e.g. acme.lobu.com)
	// and — when AUTH_COOKIE_DOMAIN is configured — sibling subdomains under the
	// cookie zone so browsers on `acme.lobu.ai` can call `app.lobu.ai`.
	const parsedHost = parsed.hostname.toLowerCase();
	const baseDomain = new URL(canonicalOrigin).hostname.toLowerCase();
	if (parsedHost.endsWith(`.${baseDomain}`)) return true;

	const subdomainZone = getSubdomainZone(
		canonicalOrigin,
		env.AUTH_COOKIE_DOMAIN,
	);
	return !!(
		subdomainZone &&
		(parsedHost === subdomainZone || parsedHost.endsWith(`.${subdomainZone}`))
	);
}
