import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Env } from '@lobu/connector-sdk';
import { Hono } from 'hono';
import { createGatewayApp } from '../../gateway/cli/gateway';
import { app } from '../../index';
import { buildWrapperApp } from '../../server-lifecycle';
import {
  getOwnedOwlettoExtensionIds,
  isAllowedCorsOrigin,
} from '../../utils/cors-origin';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin';

// The Hono CORS middleware in packages/server/src/index.ts must accept
// `chrome-extension://<our id>`
// or the Owletto service worker's `/api/workers/poll` fetch fails the
// preflight with "No 'Access-Control-Allow-Origin' header is present on the
// requested resource" — exactly the regression we're closing.
//
// Behind a TLS-terminating proxy `c.req.url` is http://; we use the same
// shape here so the canonical-origin check exercises the configured public
// origin path.

const REQUEST_URL = 'http://10.0.0.1/api/workers/poll';

const ORIGINAL_PUBLIC_GATEWAY_URL = process.env.PUBLIC_GATEWAY_URL;
const ORIGINAL_AUTH_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN;
const ORIGINAL_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

function makeEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    ...overrides,
  } as Env;
}

beforeEach(() => {
  process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
  process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
  delete process.env.ALLOWED_ORIGINS;
  __resetPublicOriginCachesForTests();
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_GATEWAY_URL === undefined) {
    delete process.env.PUBLIC_GATEWAY_URL;
  } else {
    process.env.PUBLIC_GATEWAY_URL = ORIGINAL_PUBLIC_GATEWAY_URL;
  }
  if (ORIGINAL_AUTH_COOKIE_DOMAIN === undefined) {
    delete process.env.AUTH_COOKIE_DOMAIN;
  } else {
    process.env.AUTH_COOKIE_DOMAIN = ORIGINAL_AUTH_COOKIE_DOMAIN;
  }
  if (ORIGINAL_ALLOWED_ORIGINS === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
  }
  __resetPublicOriginCachesForTests();
});

describe('getOwnedOwlettoExtensionIds', () => {
  test('always includes both the dev/unpacked and published store ids', () => {
    const ids = getOwnedOwlettoExtensionIds(makeEnv());
    // Dev/unpacked id, derived from the manifest `key`.
    expect(ids).toContain('amnnhclgmbldmfcfamonoggjhfidemmm');
    // Chrome Web Store id — without this, app.lobu.ai's frame-ancestors
    // blocked the published sidepanel iframe even though local dev worked.
    expect(ids).toContain('jhgcecbdpnoehfnhpdfihlchjddapepi');
  });

  test('merges in well-formed ids from LOBU_OWLETTO_EXTENSION_IDS', () => {
    const fakeDevId = 'abcdefghijklmnopabcdefghijklmnop'; // 32 chars, [a-p]
    const ids = getOwnedOwlettoExtensionIds(
      makeEnv({ LOBU_OWLETTO_EXTENSION_IDS: `  ${fakeDevId} , bogus-id, ` })
    );
    expect(ids).toContain('amnnhclgmbldmfcfamonoggjhfidemmm');
    expect(ids).toContain('jhgcecbdpnoehfnhpdfihlchjddapepi');
    expect(ids).toContain(fakeDevId);
    expect(ids).not.toContain('bogus-id');
  });
});

describe('isAllowedCorsOrigin — chrome-extension://', () => {
  test('accepts the dev/unpacked Owletto extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://amnnhclgmbldmfcfamonoggjhfidemmm',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('accepts the published Chrome Web Store extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://jhgcecbdpnoehfnhpdfihlchjddapepi',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('accepts an extra id configured via LOBU_OWLETTO_EXTENSION_IDS', () => {
    const fakeDevId = 'abcdefghijklmnopabcdefghijklmnop';
    expect(
      isAllowedCorsOrigin(
        `chrome-extension://${fakeDevId}`,
        makeEnv({ LOBU_OWLETTO_EXTENSION_IDS: fakeDevId }),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('rejects an unknown chrome-extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(false);
  });

  test('rejects http:// pretending to be the extension id (no protocol mismatch)', () => {
    expect(
      isAllowedCorsOrigin(
        'http://amnnhclgmbldmfcfamonoggjhfidemmm',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(false);
  });
});

describe('isAllowedCorsOrigin — regression coverage for pre-existing branches', () => {
  test('still accepts the canonical https origin', () => {
    expect(isAllowedCorsOrigin('https://app.lobu.ai', makeEnv(), REQUEST_URL)).toBe(true);
  });

  test('still accepts wildcard subdomains of the public origin', () => {
    expect(isAllowedCorsOrigin('https://acme.app.lobu.ai', makeEnv(), REQUEST_URL)).toBe(true);
  });

  test('accepts sibling workspace subdomains in the configured cookie zone', () => {
    expect(
      isAllowedCorsOrigin(
        'https://umit-unal.lobu.ai',
        makeEnv({ AUTH_COOKIE_DOMAIN: '.lobu.ai' }),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('accepts trimmed exact ALLOWED_ORIGINS entries for standalone clients', () => {
    expect(
      isAllowedCorsOrigin(
        'https://console.example.com',
        makeEnv({ ALLOWED_ORIGINS: ' https://console.example.com , malformed ' }),
        REQUEST_URL,
        { allowConfiguredOrigins: true }
      )
    ).toBe(true);
  });

  test('does not widen the main-app policy with Agent API standalone origins', () => {
    expect(
      isAllowedCorsOrigin(
        'https://console.example.com',
        makeEnv({ ALLOWED_ORIGINS: 'https://console.example.com' }),
        REQUEST_URL
      )
    ).toBe(false);
  });

  test('still rejects an arbitrary third-party origin', () => {
    expect(isAllowedCorsOrigin('https://evil.com', makeEnv(), REQUEST_URL)).toBe(false);
  });

  test('rejects a cookie-zone lookalike hostname', () => {
    expect(
      isAllowedCorsOrigin(
        'https://umit-unal.lobu.ai.evil.example',
        makeEnv({ AUTH_COOKIE_DOMAIN: '.lobu.ai' }),
        REQUEST_URL
      )
    ).toBe(false);
  });
});

describe('embedded /lobu Agent API CORS boundary', () => {
  function buildAgentGateway() {
    const rawGateway = createGatewayApp({
      secretProxy: null,
      workerGateway: null,
      mcpProxy: null,
    });
    const lobuApp = new Hono();
    lobuApp.route('/', rawGateway);
    return buildWrapperApp(makeEnv(), lobuApp, new Hono());
  }

  // The gateway's CORS callback resolves its zone from process.env (see
  // gateway.ts), which `beforeEach` pins to `.lobu.ai`; the env handed to
  // `fetch` only feeds the wrapper's injection middleware.
  function preflight(origin: string) {
    return buildAgentGateway().fetch(
      new Request('https://app.lobu.ai/lobu/api/v1/agents/example/messages', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
      makeEnv()
    );
  }

  test('allows credentialed message preflight from a workspace subdomain', async () => {
    const response = await preflight('https://umit-unal.lobu.ai');

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://umit-unal.lobu.ai'
    );
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('preserves canonical app and localhost browser clients', async () => {
    const canonical = await preflight('https://app.lobu.ai');
    const localhost = await preflight('http://localhost:5173');

    expect(canonical.headers.get('access-control-allow-origin')).toBe(
      'https://app.lobu.ai'
    );
    expect(localhost.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173'
    );
  });

  test('requires an explicitly configured zone for sibling workspace hosts', async () => {
    delete process.env.AUTH_COOKIE_DOMAIN;
    __resetPublicOriginCachesForTests();

    const response = await preflight('https://umit-unal.lobu.ai');

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('preserves exact standalone Agent API origins', async () => {
    delete process.env.AUTH_COOKIE_DOMAIN;
    process.env.ALLOWED_ORIGINS = ' https://console.example.com ';
    __resetPublicOriginCachesForTests();

    const response = await preflight('https://console.example.com');

    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://console.example.com'
    );
  });

  test('does not allow an unrelated site to call the Agent API', async () => {
    const response = await preflight('https://evil.example');

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('MCP browser Origin boundary', () => {
  test('rejects a hostile Origin before authentication or tool dispatch', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      makeEnv()
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'forbidden',
      message: 'Untrusted MCP Origin',
    });
  });

  test('allows standard Streamable HTTP headers in browser preflight', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp/acme', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'authorization,content-type,mcp-session-id,mcp-protocol-version,last-event-id',
        },
      }),
      makeEnv()
    );
    expect(response.status).toBe(204);
    const allowHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowHeaders).toContain('mcp-session-id');
    expect(allowHeaders).toContain('mcp-protocol-version');
    expect(allowHeaders).toContain('last-event-id');
    const exposeHeaders = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
    expect(exposeHeaders).toContain('mcp-session-id');
    expect(exposeHeaders).toContain('mcp-protocol-version');
    expect(exposeHeaders).toContain('www-authenticate');
  });
});
