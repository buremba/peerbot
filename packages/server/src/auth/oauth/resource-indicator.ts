/**
 * RFC 8707 resource indicators for the MCP endpoints.
 *
 * MCP clients name the exact protected resource they want a token for; the
 * gateway canonicalizes that value so an audience check is a string compare,
 * and advertises the matching RFC 9728 metadata URL in `WWW-Authenticate`.
 */

import { getConfiguredSubdomainZone, normalizeHost } from '../../utils/public-origin';
import { resolveBaseUrl } from '../base-url';
import { DEFAULT_SCOPES_STRING } from './scopes';

/**
 * The request URL as the client sees it: the configured public origin, else the
 * reverse proxy's forwarded origin, plus the request path with any trailing
 * slash removed.
 *
 * Every site in this module — the `WWW-Authenticate` challenge, the
 * authorize/consent/device/token canonicalization, and the per-request audience
 * check — starts here, so all four agree on one string. Resolving the origin
 * differently at any one of them would reject a correctly-bound token behind a
 * TLS-terminating proxy.
 */
export function publicMcpRequestUrl(request: Request): string {
  // The MCP protected-resource identifier belongs to the resource server, not
  // the authorization server / general web gateway. In production those are
  // intentionally different (`lobu.ai/mcp` vs `app.lobu.ai`). Prefer the
  // actual serving/forwarded host for the MCP request so RFC 9728 metadata and
  // WWW-Authenticate stay bound to the URL the client called.
  const origin = resolveBaseUrl({ request, skipEnvOverride: true });
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  return `${origin}${pathname}`;
}

/** Canonical MCP protected-resource URI accepted for OAuth audience binding. */
export function canonicalizeMcpResource(
  rawResource: string | null | undefined,
  requestUrl: string
): string | null {
  if (!rawResource) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawResource);
  } catch {
    return null;
  }
  // The resource server may intentionally use a sibling/parent host from the
  // authorization server (prod: lobu.ai/mcp vs app.lobu.ai/oauth/*). Accept the
  // exact request origin, plus hosts inside the explicitly configured cookie /
  // workspace zone. Never infer a parent domain from hostname text: without an
  // explicit AUTH_COOKIE_DOMAIN, cross-origin resources stay fail-closed.
  const request = new URL(requestUrl);
  const resourceHost = normalizeHost(parsed.hostname);
  const requestHost = normalizeHost(request.hostname);
  const zone = getConfiguredSubdomainZone();
  const sameOrigin = parsed.origin === request.origin;
  const sameTransport = parsed.protocol === request.protocol && parsed.port === request.port;
  const requestInConfiguredZone = Boolean(
    zone && requestHost && (requestHost === zone || requestHost.endsWith(`.${zone}`))
  );
  const inConfiguredZone = Boolean(
    sameTransport &&
      requestInConfiguredZone &&
      zone &&
      resourceHost &&
      (resourceHost === zone || resourceHost.endsWith(`.${zone}`))
  );
  if (
    (!sameOrigin && !inConfiguredZone) ||
    !resourceHost ||
    !requestHost ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/mcp' && !/^\/mcp\/[^/]+$/.test(path)) return null;
  return `${parsed.origin}${path}`;
}

/** The resource URI the incoming request is addressing, if it is an MCP route. */
export function getMcpResourceForRequest(requestUrl: string): string | null {
  const request = new URL(requestUrl);
  return canonicalizeMcpResource(
    `${request.origin}${request.pathname}`,
    requestUrl
  );
}

/** RFC 9728 metadata URL for the resource the request addresses. */
export function getProtectedResourceMetadataUrl(requestUrl: string): string {
  const publicOrigin = new URL(requestUrl).origin;
  const resource = getMcpResourceForRequest(requestUrl);
  if (!resource) return `${publicOrigin}/.well-known/oauth-protected-resource`;
  return `${publicOrigin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
}

export interface McpBearerChallengeOptions {
  error?: 'invalid_token' | 'insufficient_scope' | string;
  errorDescription?: string;
  scope?: string;
}

function quoteChallengeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMcpBearerChallenge(
  requestUrl: string,
  errorOrOptions?: string | McpBearerChallengeOptions
): string {
  const options: McpBearerChallengeOptions =
    typeof errorOrOptions === 'string' ? { error: errorOrOptions } : (errorOrOptions ?? {});
  const params = [
    `resource_metadata=${quoteChallengeValue(getProtectedResourceMetadataUrl(requestUrl))}`,
    `scope=${quoteChallengeValue(options.scope ?? DEFAULT_SCOPES_STRING)}`,
  ];
  if (options.error) params.push(`error=${quoteChallengeValue(options.error)}`);
  if (options.errorDescription) {
    params.push(`error_description=${quoteChallengeValue(options.errorDescription)}`);
  }
  return `Bearer ${params.join(', ')}`;
}
