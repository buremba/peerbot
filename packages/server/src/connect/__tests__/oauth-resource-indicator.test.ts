import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRefreshRequest } from '../../auth/oauth/token-refresh';
import { buildAuthorizationUrl, exchangeCodeForTokens } from '../oauth-providers';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OAuth resource indicators', () => {
  it('includes the MCP resource in authorization and code exchange requests', async () => {
    const resource = 'https://mcp.example.com/rpc';
    const authorizationUrl = buildAuthorizationUrl({
      provider: 'mcp.example',
      clientId: 'client-id',
      redirectUri: 'https://lobu.example.com/connect/oauth/callback',
      scopes: ['read:issues', 'write:issues'],
      state: 'state-token',
      authorizationUrl: 'https://auth.example.com/authorize',
      codeChallenge: 'pkce-challenge',
      resource,
    });
    expect(authorizationUrl).not.toBeNull();
    const authorize = new URL(authorizationUrl!);
    expect(authorize.searchParams.get('resource')).toBe(resource);
    expect(authorize.searchParams.get('code_challenge')).toBe('pkce-challenge');

    let tokenBody = '';
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      tokenBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    await expect(
      exchangeCodeForTokens({
        provider: 'mcp.example',
        code: 'authorization-code',
        clientId: 'client-id',
        redirectUri: 'https://lobu.example.com/connect/oauth/callback',
        tokenUrl: 'https://auth.example.com/token',
        tokenEndpointAuthMethod: 'none',
        codeVerifier: 'pkce-verifier',
        resource,
      })
    ).resolves.toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(new URLSearchParams(tokenBody).get('resource')).toBe(resource);
    expect(new URLSearchParams(tokenBody).get('code_verifier')).toBe('pkce-verifier');
  });

  it('keeps the MCP resource on account-token refresh', () => {
    const resource = 'https://mcp.example.com/rpc';
    const request = buildRefreshRequest({
      profile: 'account-credential',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      authMethod: 'none',
      resource,
    });
    expect(new URLSearchParams(request.body).get('resource')).toBe(resource);
  });
});
