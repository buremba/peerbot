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
 * Always matches a built bundle (`packages/owletto-web/dist/index.html`). In
 * development it additionally matches a source checkout
 * (`packages/owletto-web/index.html`), which is what the Vite middleware serves —
 * gated on NODE_ENV so a stray source tree in a production image does not
 * cause request-origin links to leak out.
 */
export function hasLocalFrontend(): boolean {
  if (localFrontendCache !== undefined) return localFrontendCache;

  const envDist = process.env.WEB_DIST_DIR?.trim();
  const isDevelopment = process.env.NODE_ENV === 'development';
  const candidates = [
    envDist ? path.join(envDist, 'index.html') : undefined,
    path.resolve(APP_ROOT, 'packages/owletto-web/dist/index.html'),
    path.resolve(APP_ROOT, '../owletto-web/dist/index.html'),
    path.resolve(process.cwd(), 'packages/owletto-web/dist/index.html'),
    path.resolve(process.cwd(), '../packages/owletto-web/dist/index.html'),
    isDevelopment ? path.resolve(APP_ROOT, 'packages/owletto-web/index.html') : undefined,
    isDevelopment ? path.resolve(APP_ROOT, '../owletto-web/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), 'packages/owletto-web/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), '../packages/owletto-web/index.html') : undefined,
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

  const requestHost = request.hostname.toLowerCase();
  const canonicalHost = canonical.hostname.toLowerCase();

  if (LOCALHOST_HOSTNAMES.has(requestHost)) return null;
  if (request.origin === canonical.origin) return null;
  if (requestHost === canonicalHost || requestHost.endsWith(`.${canonicalHost}`)) {
    return null;
  }

  const cookieZone = cookieDomain?.trim().replace(/^\./, '').toLowerCase();
  if (cookieZone && (requestHost === cookieZone || requestHost.endsWith(`.${cookieZone}`))) {
    return null;
  }

  return `${canonical.origin}${request.pathname}${request.search}`;
}
