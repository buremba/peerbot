/**
 * RFC 8707 resource indicators for the MCP endpoints.
 *
 * MCP clients name the exact protected resource they want a token for; the
 * gateway canonicalizes that value so an audience check is a string compare,
 * and advertises the matching RFC 9728 metadata URL in `WWW-Authenticate`.
 */

import { resolvePublicOrigin } from '../../utils/public-origin';
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
  const origin = resolveBaseUrl({ request });
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  return `${origin}${pathname}`;
}

/**
 * Extra public origins that may address the MCP endpoints (RFC 8707
 * resource indicators). The gateway canonicalizes any allowed origin to its
 * own public origin, so audience checks stay a single string compare. Set
 * `MCP_PUBLIC_RESOURCE_ORIGINS` to a comma-separated list of origins, e.g.
 * `https://lobu.ai` when the edge proxies the same gateway under another
 * domain.
 */
function extraMcpResourceOrigins(): string[] {
  return (process.env.MCP_PUBLIC_RESOURCE_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
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
  const publicOrigin = resolvePublicOrigin(requestUrl);
  const allowedOrigins = new Set([publicOrigin, ...extraMcpResourceOrigins()]);
  if (!allowedOrigins.has(parsed.origin) || parsed.search || parsed.hash) return null;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/mcp' && !/^\/mcp\/[^/]+$/.test(path)) return null;
  return `${publicOrigin}${path}`;
}

/** The resource URI the incoming request is addressing, if it is an MCP route. */
export function getMcpResourceForRequest(requestUrl: string): string | null {
  const request = new URL(requestUrl);
  return canonicalizeMcpResource(
    `${resolvePublicOrigin(requestUrl)}${request.pathname}`,
    requestUrl
  );
}

/** RFC 9728 metadata URL for the resource the request addresses. */
export function getProtectedResourceMetadataUrl(requestUrl: string): string {
  const publicOrigin = resolvePublicOrigin(requestUrl);
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
