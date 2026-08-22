/**
 * Progressive `mcp:admin` consent — re-authorizing REPLACES a narrower grant.
 *
 * When `run_sdk` hits a nested admin-only SDK method, the MCP result carries an
 * `insufficient_scope` challenge naming the COMPLETE replacement grant
 * (`mcp:read mcp:write mcp:admin`), not just the missing `mcp:admin` delta —
 * hosts that replace rather than merge grants would otherwise drop read/write
 * on the upgrade. That contract only holds if the authorization-code path
 * actually issues the wider grant on a second consent for a client that already
 * holds a narrower one.
 *
 * This drives the real `oauthRoutes`: register → consent → token at
 * `mcp:read mcp:write`, then consent → token again at
 * `mcp:read mcp:write mcp:admin`, asserting the token response reports the
 * elevated scope.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

// The consent handler enforces `isAllowedConsentOrigin`: the request must carry
// an Origin matching the app's own base URL. The test app is served at
// http://localhost, so send that as Origin.
const ORIGIN = 'http://localhost';

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  return app;
}

function call(
  app: Hono<{ Bindings: Env }>,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...opts?.headers,
  };
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    TEST_ENV
  );
}

async function authorizeCodeGrant(params: {
  app: Hono<{ Bindings: Env }>;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  sessionCookie: string;
}): Promise<{ access_token: string; scope?: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await call(params.app, 'POST', '/oauth/authorize/consent', {
    body: {
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      scope: params.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: params.resource,
      approved: true,
    },
    headers: { Cookie: params.sessionCookie },
  });
  expect(authorize.status).toBe(200);
  const { redirect_url } = (await authorize.json()) as { redirect_url: string };
  const code = new URL(redirect_url).searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await call(params.app, 'POST', '/oauth/token', {
    body: {
      grant_type: 'authorization_code',
      code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_verifier: verifier,
      resource: params.resource,
    },
  });
  expect(token.status).toBe(200);
  return token.json() as Promise<{ access_token: string; scope?: string }>;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

afterAll(async () => {
  // app is in-process; nothing to tear down
});

describe('Progressive mcp:admin consent', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  // The grant path never branches on `client_name`, so one registered client
  // covers every MCP host that walks this flow (ChatGPT, Claude Desktop, …).
  it('replaces a read/write grant with a cumulative admin grant', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'Progressive Admin Org' });
    const user = await createTestUser({ name: 'Progressive Admin User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/callback`;
    const resource = `${ORIGIN}/mcp/${org.slug}`;

    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Progressive Admin Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const initial = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource,
      scope: 'mcp:read mcp:write',
      sessionCookie: session.cookieHeader,
    });
    expect(initial.scope).toBe('mcp:read mcp:write');

    const elevated = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource,
      scope: 'mcp:read mcp:write mcp:admin',
      sessionCookie: session.cookieHeader,
    });
    expect(elevated.scope).toBe('mcp:read mcp:write mcp:admin');
  });
});
