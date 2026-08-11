import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildMcpBearerChallenge,
  canonicalizeMcpResource,
  getProtectedResourceMetadataUrl,
  publicMcpRequestUrl,
} from '../../auth/oauth/resource-indicator.js';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin.js';

const originalPublicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;
const originalAuthCookieDomain = process.env.AUTH_COOKIE_DOMAIN;

beforeEach(() => {
  process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
  delete process.env.AUTH_COOKIE_DOMAIN;
  __resetPublicOriginCachesForTests();
});

afterEach(() => {
  if (originalPublicGatewayUrl === undefined) {
    delete process.env.PUBLIC_GATEWAY_URL;
  } else {
    process.env.PUBLIC_GATEWAY_URL = originalPublicGatewayUrl;
  }
  if (originalAuthCookieDomain === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
  else process.env.AUTH_COOKIE_DOMAIN = originalAuthCookieDomain;
  __resetPublicOriginCachesForTests();
});

describe('MCP OAuth resource indicators', () => {
  test('canonicalizes only the root or one org-scoped MCP path', () => {
    const requestUrl = 'https://app.lobu.ai/mcp/acme';

    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme/', requestUrl)).toBe(
      'https://app.lobu.ai/mcp/acme'
    );
    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme/tools', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://evil.example/mcp/acme', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme?admin=1', requestUrl)).toBeNull();
  });

  test('builds an exact path-specific protected-resource challenge', () => {
    const requestUrl = 'https://app.lobu.ai/mcp/acme';

    expect(getProtectedResourceMetadataUrl(requestUrl)).toBe(
      'https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme'
    );
    expect(buildMcpBearerChallenge(requestUrl, 'invalid_token')).toBe(
      'Bearer resource_metadata="https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme", scope="mcp:read mcp:write", error="invalid_token"'
    );
  });

  test('escapes challenge values and advertises the exact missing scope', () => {
    expect(
      buildMcpBearerChallenge('https://app.lobu.ai/mcp/acme', {
        error: 'insufficient_scope',
        errorDescription: 'Expired "access" \\ token',
        scope: 'mcp:admin',
      })
    ).toBe(
      'Bearer resource_metadata="https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme", scope="mcp:admin", error="insufficient_scope", error_description="Expired \\"access\\" \\\\ token"'
    );
  });


  test('accepts the hosted MCP resource across the explicitly configured Lobu zone', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBe('https://lobu.ai/mcp');
    expect(
      canonicalizeMcpResource('https://acme.lobu.ai/mcp/acme', 'https://app.lobu.ai/oauth/token')
    ).toBe('https://acme.lobu.ai/mcp/acme');
    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://evil.example/oauth/authorize')
    ).toBeNull();
  });

  test('rejects cross-origin MCP resources when no explicit zone authorizes them', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    delete process.env.AUTH_COOKIE_DOMAIN;
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBeNull();
    expect(
      canonicalizeMcpResource('https://evil.example/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBeNull();
  });

  test('rejects port, credential, and scheme changes even inside the configured zone', () => {
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();
    const requestUrl = 'https://app.lobu.ai/oauth/authorize';

    expect(canonicalizeMcpResource('https://lobu.ai:444/mcp', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('http://lobu.ai/mcp', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://user@lobu.ai/mcp', requestUrl)).toBeNull();
  });

  test('uses the canonical origin embedded in an already-public request URL', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp/acme', 'https://lobu.ai/mcp/acme')
    ).toBe('https://lobu.ai/mcp/acme');
    expect(getProtectedResourceMetadataUrl('https://lobu.ai/mcp/acme')).toBe(
      'https://lobu.ai/.well-known/oauth-protected-resource/mcp/acme'
    );
  });

  test('publicMcpRequestUrl prefers the MCP request host over PUBLIC_GATEWAY_URL', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://lobu.ai/mcp', {
      headers: {
        host: 'lobu.ai',
        'x-forwarded-host': 'lobu.ai',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://lobu.ai/mcp');
    expect(buildMcpBearerChallenge(publicMcpRequestUrl(request))).toContain(
      'resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource/mcp"'
    );
  });
});
