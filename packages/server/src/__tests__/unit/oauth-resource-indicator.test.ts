import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildMcpBearerChallenge,
  canonicalizeMcpResource,
  getProtectedResourceMetadataUrl,
} from '../../auth/oauth/resource-indicator.js';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin.js';

const originalPublicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

beforeEach(() => {
  process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
  __resetPublicOriginCachesForTests();
});

afterEach(() => {
  if (originalPublicGatewayUrl === undefined) {
    delete process.env.PUBLIC_GATEWAY_URL;
  } else {
    process.env.PUBLIC_GATEWAY_URL = originalPublicGatewayUrl;
  }
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

  test('uses the configured public origin rather than an internal request host', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://lobu.example/lobu';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.example/mcp/acme', 'http://internal:8787/mcp/acme')
    ).toBe('https://lobu.example/mcp/acme');
    expect(getProtectedResourceMetadataUrl('http://internal:8787/mcp/acme')).toBe(
      'https://lobu.example/.well-known/oauth-protected-resource/mcp/acme'
    );
  });

  test('accepts extra configured public origins and canonicalizes to the gateway origin', () => {
    process.env.MCP_PUBLIC_RESOURCE_ORIGINS = 'https://lobu.ai, https://mcp.example/';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://app.lobu.ai/mcp')
    ).toBe('https://app.lobu.ai/mcp');
    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp/acme', 'https://app.lobu.ai/mcp')
    ).toBe('https://app.lobu.ai/mcp/acme');
    expect(
      canonicalizeMcpResource('https://mcp.example/mcp', 'https://app.lobu.ai/mcp')
    ).toBe('https://app.lobu.ai/mcp');
  });

  test('still rejects origins outside the public origin allowlist', () => {
    process.env.MCP_PUBLIC_RESOURCE_ORIGINS = 'https://lobu.ai';
    __resetPublicOriginCachesForTests();

    expect(canonicalizeMcpResource('https://evil.example/mcp', 'https://app.lobu.ai/mcp')).toBeNull();
    expect(canonicalizeMcpResource('https://lobu.ai/mcp/../../admin', 'https://app.lobu.ai/mcp')).toBeNull();
  });
});
