import { describe, expect, it } from 'vitest';
import {
  buildBearerChallenge,
  protectedResourceMetadataUrl,
} from '../resource-challenge';

describe('MCP OAuth resource challenges', () => {
  it('uses the actual serving origin instead of PUBLIC_GATEWAY_URL', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    const request = new Request('https://internal.invalid/mcp', {
      headers: {
        host: 'lobu.ai',
        'x-forwarded-host': 'lobu.ai',
        'x-forwarded-proto': 'https',
      },
    });

    expect(protectedResourceMetadataUrl(request)).toBe(
      'https://lobu.ai/.well-known/oauth-protected-resource'
    );
    expect(buildBearerChallenge(request)).toBe(
      'Bearer resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource"'
    );
  });

  it('advertises path-specific metadata for a scoped MCP resource', () => {
    const request = new Request('https://lobu.ai/mcp/acme');
    expect(protectedResourceMetadataUrl(request)).toBe(
      'https://lobu.ai/.well-known/oauth-protected-resource/mcp/acme'
    );
    expect(
      buildBearerChallenge(request, {
        error: 'invalid_token',
        errorDescription: 'Expired "access" token',
      })
    ).toBe(
      'Bearer resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource/mcp/acme", error="invalid_token", error_description="Expired \\"access\\" token"'
    );
  });

  it('keeps a normal realm challenge for non-MCP HTTP resources', () => {
    const request = new Request('https://app.lobu.ai/api/acme/private');
    expect(buildBearerChallenge(request, { error: 'invalid_token' })).toBe(
      'Bearer realm="https://app.lobu.ai", error="invalid_token"'
    );
  });
});
