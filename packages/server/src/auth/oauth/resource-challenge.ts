import { resolveBaseUrl } from '../base-url';

export interface BearerChallengeOptions {
  error?: 'invalid_token' | 'insufficient_scope';
  errorDescription?: string;
  scope?: string;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Resolve the RFC 9728 metadata document for the exact MCP resource being
 * challenged. This deliberately ignores PUBLIC_GATEWAY_URL: a request served
 * at lobu.ai must advertise lobu.ai's metadata, not the app.lobu.ai gateway
 * origin used for unrelated generated links.
 */
export function protectedResourceMetadataUrl(request: Request): string {
  const resourceUrl = new URL(canonicalMcpResourceUrl(request));
  const servingOrigin = resourceUrl.origin;
  const pathname = resourceUrl.pathname;
  if (pathname === '/mcp') {
    return `${servingOrigin}/.well-known/oauth-protected-resource`;
  }
  if (pathname.startsWith('/mcp/')) {
    return `${servingOrigin}/.well-known/oauth-protected-resource${pathname}`;
  }
  return `${servingOrigin}/.well-known/oauth-protected-resource`;
}

/** Resolve the externally served MCP resource URL without its query string. */
export function canonicalMcpResourceUrl(request: Request): string {
  const servingOrigin = resolveBaseUrl({ request, skipEnvOverride: true });
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  return `${servingOrigin}${pathname}`;
}

/** Build an RFC 6750 challenge, using RFC 9728 resource_metadata for MCP. */
export function buildBearerChallenge(
  request: Request,
  options: BearerChallengeOptions = {}
): string {
  const pathname = new URL(request.url).pathname;
  const isMcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
  const servingOrigin = resolveBaseUrl({ request, skipEnvOverride: true });
  const params = [
    isMcp
      ? `resource_metadata=${quote(protectedResourceMetadataUrl(request))}`
      : `realm=${quote(servingOrigin)}`,
  ];
  if (options.error) params.push(`error=${quote(options.error)}`);
  if (options.errorDescription) {
    params.push(`error_description=${quote(options.errorDescription)}`);
  }
  if (options.scope) params.push(`scope=${quote(options.scope)}`);
  return `Bearer ${params.join(', ')}`;
}
