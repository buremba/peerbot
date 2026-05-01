/**
 * Canonical public origin resolution.
 *
 * PUBLIC_WEB_URL remains the explicit override.
 * LOBU_URL is the next fallback so hosted Owletto instances can surface under
 * the Lobu community URL without hardcoding a domain in application code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTED_UI_FALLBACK_ORIGIN = 'https://app.lobu.ai';

function toOrigin(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function getConfiguredPublicOrigin(): string | undefined {
  return toOrigin(process.env.PUBLIC_WEB_URL) ?? toOrigin(process.env.LOBU_URL);
}

const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

let localFrontendCache: boolean | undefined;

/**
 * Sync check for a locally available frontend. Used by MCP URL builders to
 * decide whether to return the hosted UI fallback when neither PUBLIC_WEB_URL
 * nor LOBU_URL is configured.
 *
 * Always matches a built bundle (`packages/web/dist/index.html`). In
 * development it additionally matches a source checkout
 * (`packages/web/index.html`), which is what the Vite middleware serves —
 * gated on NODE_ENV so a stray source tree in a production image does not
 * cause request-origin links to leak out.
 */
export function hasLocalFrontend(): boolean {
  if (localFrontendCache !== undefined) return localFrontendCache;

  const envDist = process.env.WEB_DIST_DIR?.trim();
  const isDevelopment = process.env.NODE_ENV === 'development';
  const candidates = [
    envDist ? path.join(envDist, 'index.html') : undefined,
    path.resolve(APP_ROOT, 'packages/web/dist/index.html'),
    path.resolve(APP_ROOT, '../web/dist/index.html'),
    path.resolve(process.cwd(), 'packages/web/dist/index.html'),
    path.resolve(process.cwd(), '../packages/web/dist/index.html'),
    isDevelopment ? path.resolve(APP_ROOT, 'packages/web/index.html') : undefined,
    isDevelopment ? path.resolve(APP_ROOT, '../web/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), 'packages/web/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), '../packages/web/index.html') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        localFrontendCache = true;
        return true;
      }
    } catch {
      // Try next candidate.
    }
  }

  localFrontendCache = false;
  return false;
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Normalize a host or DNS zone for comparison:
 *   - strip port / leading-dot / trailing-dot / surrounding whitespace
 *   - convert IDN labels (e.g. `müller.lobu.ai`) to ASCII punycode
 *   - lowercase
 *
 * Returns null when the input cannot be parsed as a hostname. Use this on
 * both sides of any zone/host comparison so IDN-encoded requests still match
 * the canonical ASCII zone configured in env.
 */
export function normalizeHost(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const stripped = value
    .split(':')[0]
    ?.trim()
    .replace(/^\./, '')
    .replace(/\.$/, '');
  if (!stripped) return null;
  try {
    // new URL() performs IDN → punycode conversion and lowercasing.
    return new URL(`https://${stripped}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns a canonical redirect URL when browser traffic lands on a non-canonical
 * host while a public origin is configured. Subdomains of the canonical host are
 * preserved so workspace routing keeps working. When AUTH_COOKIE_DOMAIN is set
 * (e.g. ".lobu.ai") sibling subdomains of that zone are also preserved so
 * per-org subdomains like acme.lobu.ai are not bounced to app.lobu.ai.
 */
export function getCanonicalRedirectUrl(
  requestUrl: string,
  configuredOrigin = getConfiguredPublicOrigin(),
  cookieDomain = process.env.AUTH_COOKIE_DOMAIN
): string | null {
  if (!configuredOrigin) return null;

  let request: URL;
  let canonical: URL;

  try {
    request = new URL(requestUrl);
    canonical = new URL(configuredOrigin);
  } catch {
    return null;
  }

  // URL already lowercases + punycodes hostnames, so both sides are comparable.
  const requestHost = request.hostname;
  const canonicalHost = canonical.hostname;

  if (LOCALHOST_HOSTNAMES.has(requestHost)) return null;
  if (request.origin === canonical.origin) return null;
  if (requestHost === canonicalHost || requestHost.endsWith(`.${canonicalHost}`)) {
    return null;
  }

  const cookieZone = normalizeHost(cookieDomain);
  if (cookieZone && (requestHost === cookieZone || requestHost.endsWith(`.${cookieZone}`))) {
    return null;
  }

  return `${canonical.origin}${request.pathname}${request.search}`;
}

/**
 * Returns the DNS zone used to map `{sub}.{zone}` hostnames to an organization
 * slug. Prefers AUTH_COOKIE_DOMAIN (e.g. `.lobu.ai`) so per-org subdomains like
 * `acme.lobu.ai` resolve even when PUBLIC_WEB_URL points at a non-apex canonical
 * host like `app.lobu.ai`. Falls back to the configured origin's hostname so
 * deployments without a cookie zone still get subdomain extraction for
 * `{sub}.{canonicalHost}`.
 */
export function getSubdomainZone(
  configuredOrigin = getConfiguredPublicOrigin(),
  cookieDomain = process.env.AUTH_COOKIE_DOMAIN
): string | null {
  const cookieZone = normalizeHost(cookieDomain);
  if (cookieZone) return cookieZone;

  if (!configuredOrigin) return null;
  try {
    return normalizeHost(new URL(configuredOrigin).hostname);
  } catch {
    return null;
  }
}

/**
 * Extracts the org slug from a Host header for `{org}.{zone}` requests.
 * Reserved subdomains (www, api, app, etc.) are skipped so infra hostnames are
 * not mistaken for org slugs. Returns null when the host does not belong to the
 * zone, is the bare zone, or is a reserved/multi-label subdomain.
 */
export function extractSubdomainOrg(
  host: string | undefined | null,
  zone: string | null | undefined,
  reservedSubdomains: ReadonlySet<string>
): string | null {
  const normalizedHost = normalizeHost(host);
  const normalizedZone = normalizeHost(zone);
  if (!normalizedHost || !normalizedZone) return null;
  if (!normalizedHost.endsWith(`.${normalizedZone}`)) return null;

  const sub = normalizedHost.slice(0, -(normalizedZone.length + 1));
  if (!sub || sub.includes('.') || reservedSubdomains.has(sub)) return null;
  return sub;
}
