import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../credential-resolver', () => ({
  resolveCredentials: vi.fn(async () => null),
  resolveCredentialsByConnectionId: vi.fn(async () => null),
}));

import {
  callTool,
  discoverTools,
  probeMcpServer,
  registerMcpOAuthClient,
} from '../client';

const jsonResponse = (body: unknown, sessionId?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('probeMcpServer capability discovery', () => {
  it('discovers OAuth metadata when initialize returns a protected-resource challenge', async () => {
    const upstreamUrl = 'https://mcp.example.com/rpc';
    const resourceMetadataUrl =
      'https://mcp.example.com/.well-known/oauth-protected-resource/rpc';
    const authorizationServer = 'https://auth.example.com/tenant';
    const authorizationMetadataUrl =
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant';

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === upstreamUrl) {
        return new Response(
          JSON.stringify({ error: 'invalid_token' }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
            },
          }
        );
      }
      if (href === resourceMetadataUrl) {
        return jsonResponse({
          resource: upstreamUrl,
          authorization_servers: [authorizationServer],
          scopes_supported: ['read:issues', 'write:issues', 'offline_access'],
        });
      }
      if (href === authorizationMetadataUrl) {
        return jsonResponse({
          issuer: authorizationServer,
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const result = await probeMcpServer(upstreamUrl);
    expect(result).toMatchObject({
      serverInfo: { name: 'mcp.example.com', version: '0.0.0' },
      tools: [],
      oauth: {
        resource: upstreamUrl,
        resourceMetadataUrl,
        authorizationServer,
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        registrationUrl: 'https://auth.example.com/register',
        scopesSupported: ['read:issues', 'write:issues', 'offline_access'],
        tokenEndpointAuthMethodsSupported: ['none'],
        codeChallengeMethodsSupported: ['S256'],
      },
    });
  });

  it('accepts a truly toolless server without calling tools/list', async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ headers: new Headers(init?.headers), body });
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { resources: {} },
              serverInfo: { name: 'toolless', version: '1.0.0' },
            },
          },
          'session-1'
        );
      }
      return jsonResponse({});
    }) as typeof fetch;

    const result = await probeMcpServer('https://mcp.example.com/rpc');
    expect(result.tools).toEqual([]);
    expect(requests.map((request) => request.body.method)).not.toContain('tools/list');
    expect(requests[1]?.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
  });

  it('fails closed when a server advertises tools but tools/list fails', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'broken-tools', version: '1.0.0' },
            },
          },
          'session-2'
        );
      }
      if (body.method === 'tools/list') {
        return new Response('upstream unavailable', { status: 503 });
      }
      return jsonResponse({});
    }) as typeof fetch;

    await expect(probeMcpServer('https://mcp.example.com/rpc')).rejects.toThrow(
      /MCP server returned 503/
    );
  });

  it('fails closed when a server advertises tools but omits the tools array', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'malformed-tools', version: '1.0.0' },
            },
          },
          'session-3'
        );
      }
      if (body.method === 'tools/list') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
      }
      return jsonResponse({});
    }) as typeof fetch;

    await expect(probeMcpServer('https://mcp.example.com/rpc')).rejects.toThrow(
      /MCP tools\/list response omitted tools/
    );
  });
});

describe('MCP OAuth dynamic client registration', () => {
  const metadata = {
    resource: 'https://mcp.example.com/rpc',
    resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/rpc',
    authorizationServer: 'https://auth.example.com/tenant',
    authorizationUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    registrationUrl: 'https://auth.example.com/register',
    scopesSupported: ['read:issues', 'write:issues', 'offline_access'],
    tokenEndpointAuthMethodsSupported: ['none'],
    codeChallengeMethodsSupported: ['S256'],
  };

  it('registers a public PKCE client with the Lobu callback', async () => {
    let registrationBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        client_id: 'registered-client',
        token_endpoint_auth_method: 'none',
      });
    }) as typeof fetch;

    await expect(
      registerMcpOAuthClient({
        metadata,
        redirectUris: ['http://127.0.0.1:8787/connect/oauth/callback'],
        clientName: 'Lobu',
      })
    ).resolves.toEqual({
      clientId: 'registered-client',
      tokenEndpointAuthMethod: 'none',
    });
    expect(registrationBody).toEqual({
      client_name: 'Lobu',
      redirect_uris: ['http://127.0.0.1:8787/connect/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read:issues write:issues offline_access',
    });
  });

  it('rejects a non-HTTPS callback that is not loopback before registration', async () => {
    globalThis.fetch = vi.fn();

    await expect(
      registerMcpOAuthClient({
        metadata,
        redirectUris: ['http://lobu.example.com/connect/oauth/callback'],
        clientName: 'Lobu',
      })
    ).rejects.toThrow(/HTTPS or HTTP on a loopback host/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('discoverTools capability discovery', () => {
  it('fails closed when an installed connector omits the negotiated tools array', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          },
          'session-4'
        );
      }
      if (body.method === 'tools/list') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    await expect(
      discoverTools(
        'malformed-tools-array',
        {
          upstream_url: 'https://mcp.example.com/rpc',
          tool_prefix: 'malformed',
        },
        'test-org-malformed-tools'
      )
    ).rejects.toThrow(/MCP tools\/list response omitted tools/);
  });
});

describe('callTool session recovery', () => {
  const config = {
    upstream_url: 'https://mcp.example.com/rpc',
    tool_prefix: 'recovery',
  };

  /** initialize → session id + negotiated protocol version. */
  const initializeResponse = (sessionId: string) =>
    jsonResponse(
      {
        jsonrpc: '2.0',
        id: 0,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
        },
      },
      sessionId
    );

  it('rehandshakes when the upstream rejects a cached session id', async () => {
    const sent: Array<{ method: unknown; sessionId: string | null }> = [];
    const expired = new Set<string>();
    let issued = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const sessionId = new Headers(init?.headers).get('mcp-session-id');
      sent.push({ method: body.method, sessionId });
      if (body.method === 'initialize') {
        issued += 1;
        return initializeResponse(`session-live-${issued}`);
      }
      // MCP Streamable HTTP requires a 404 for a session id the upstream no
      // longer knows. The tool never ran, so a replay cannot double-execute.
      if (sessionId && expired.has(sessionId)) {
        return new Response('Session not found', { status: 404 });
      }
      if (body.method === 'tools/call') {
        // The upstream drops the session right after answering, so the next
        // call arrives with a cached id it no longer recognizes.
        if (sessionId) expired.add(sessionId);
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'ok' }], isError: false },
        });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    const first = await callTool(
      'recovery-connector',
      config,
      'test-org-recovery',
      'do_thing',
      {},
      991
    );
    expect(first.isError).toBe(false);

    // Second call reuses the now-stale cached session and must recover.
    const second = await callTool(
      'recovery-connector',
      config,
      'test-org-recovery',
      'do_thing',
      {},
      991
    );
    expect(second.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(sent.filter((entry) => entry.method === 'initialize')).toHaveLength(2);
    // One rejected attempt, then exactly one replay — never a blind retry loop.
    expect(sent.filter((entry) => entry.method === 'tools/call')).toHaveLength(3);
  });

  it('never replays a tools/call after an ambiguous transport failure', async () => {
    let toolCalls = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') return initializeResponse('session-ambiguous');
      if (body.method === 'tools/call') {
        toolCalls += 1;
        // The upstream may have executed the action before the response was
        // lost, so this must surface rather than re-run the side effect.
        return new Response('gateway timeout', { status: 504 });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    await expect(
      callTool('ambiguous-connector', config, 'test-org-ambiguous', 'charge_card', {}, 992)
    ).rejects.toThrow(/Upstream MCP returned 504/);
    expect(toolCalls).toBe(1);
  });
});
