/**
 * Stage 1 — the `lobu login` device-code grant carries `connections:token`.
 *
 * The LOCAL instance's managed-connector resolver fetches managed tokens with
 * the USER's own `lobu login` credential (Stage 2). For that to pass the
 * connection-token endpoint's scope gate, the device-code grant behind
 * `lobu login` must carry `connections:token`.
 *
 * Crucially, the scope is granted ONLY when the first-party `lobu login`
 * device-code grant EXPLICITLY REQUESTS it (the CLI now includes
 * `connections:token` in its requested scope). The server no longer
 * auto-appends it on the device path — so a device client that does NOT request
 * it (or the generic authorization-code consent path arbitrary third-party MCP
 * clients use) never gets it, and tokens are never silently widened.
 *
 * This drives the real grants end-to-end against the mounted `oauthRoutes`:
 *   - device-code:  register → device_authorization (requesting
 *     `connections:token`) → device/approve → token → assert the stored scope
 *     INCLUDES `connections:token`.
 *   - auth-code:    register → authorize (consent) → token → assert the stored
 *     scope does NOT include `connections:token`.
 *
 * It also proves the gate stays meaningful: a profile-only device grant that
 * does NOT request `connections:token` does NOT get it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../../auth/oauth/utils';
import type { Env } from '../../../index';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
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

// The device-approve handler enforces `isAllowedConsentOrigin`: the request
// must carry an Origin that matches the app's own base URL. The test app is
// served at http://localhost, so send that as Origin.
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

beforeAll(async () => {
  await initWorkspaceProvider();
});

afterAll(async () => {
  // nothing to tear down — app is in-process
});

describe('Stage 1 — login token carries connections:token', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a completed device-code login grant carries connections:token', async () => {
    const app = buildApp();
    const sql = getTestDb();

    // An org the user is an owner of (so the MCP-scoped grant binds to it and
    // mcp:admin survives role filtering).
    const org = await createTestOrganization({ name: 'Login Org' });
    const user = await createTestUser({ name: 'Login User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);

    // 1. Register a device-code client (the CLI's DCR step).
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Lobu CLI test',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // 2. Device authorization — request the same scopes `lobu login` does,
    //    INCLUDING `connections:token` (the CLI now requests it explicitly; the
    //    server no longer auto-appends it). Resource binds the grant to the
    //    user's org via /mcp/<slug>.
    const deviceAuth = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'mcp:read mcp:write mcp:admin profile:read connections:token',
        resource: `${ORIGIN}/mcp/${org.slug}`,
      },
    });
    expect(deviceAuth.status).toBe(200);
    const da = (await deviceAuth.json()) as { device_code: string; user_code: string };

    // 3. Approve the device code as the logged-in user (session cookie).
    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: da.user_code, approved: true },
      headers: { Cookie: session.cookieHeader },
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()) as { status: string }).toEqual({ status: 'approved' });

    // 4. Exchange the device code for tokens.
    const tokenRes = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: da.device_code,
        client_id: client.client_id,
      },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; scope?: string };

    // The token-response scope advertises connections:token.
    expect(tokens.scope).toBeDefined();
    expect((tokens.scope as string).split(' ')).toContain('connections:token');

    // ...and the PERSISTED access-token row carries it (this is what the
    // connection-token endpoint introspects via verifyAccessToken).
    const rows = (await sql`
      SELECT scope FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)}
        AND token_type = 'access'
      LIMIT 1
    `) as unknown as Array<{ scope: string | null }>;
    expect(rows.length).toBe(1);
    expect((rows[0].scope ?? '').split(' ')).toContain('connections:token');
    // Sanity: the regular login scopes are still present.
    expect((rows[0].scope ?? '').split(' ')).toContain('mcp:read');
    expect((rows[0].scope ?? '').split(' ')).toContain('mcp:admin');
  });

  it('an authorization-code grant does NOT get connections:token (no third-party over-grant)', async () => {
    // The authorization-code consent path is used by arbitrary third-party MCP
    // clients (Claude Desktop, Cursor, …). Approving the SAME MCP scopes the CLI
    // requests must NOT silently add connections:token — only `lobu login`
    // (device-code) gets it.
    const app = buildApp();
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'AuthCode Org' });
    const user = await createTestUser({ name: 'AuthCode User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);

    const redirectUri = `${ORIGIN}/callback`;
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Third-party MCP client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // PKCE (S256).
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // Consent — approve the same MCP scopes `lobu login` requests.
    const authorize = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read mcp:write mcp:admin profile:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${ORIGIN}/mcp/${org.slug}`,
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
    });
    expect(authorize.status).toBe(200);
    const { redirect_url } = (await authorize.json()) as { redirect_url: string };
    const code = new URL(redirect_url).searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };

    const rows = (await sql`
      SELECT scope FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)}
        AND token_type = 'access'
      LIMIT 1
    `) as unknown as Array<{ scope: string | null }>;
    expect(rows.length).toBe(1);
    // The requested MCP scopes are present...
    expect((rows[0].scope ?? '').split(' ')).toContain('mcp:read');
    // ...but connections:token was NOT silently added to a third-party token.
    expect((rows[0].scope ?? '').split(' ')).not.toContain('connections:token');
  });

  it('a profile:read-only device grant (no MCP scopes) does NOT get connections:token', async () => {
    // A scope-less / profile-only grant has no org binding and never reaches the
    // managed-connector path, so it must not be widened with connections:token.
    const app = buildApp();
    const sql = getTestDb();

    const user = await createTestUser({ name: 'Profile Only User' });
    const session = await createTestSession(user.id);

    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Lobu CLI profile-only',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await reg.json()) as { client_id: string };

    const deviceAuth = await call(app, 'POST', '/oauth/device_authorization', {
      body: { client_id: client.client_id, scope: 'profile:read' },
    });
    const da = (await deviceAuth.json()) as { device_code: string; user_code: string };

    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: da.user_code, approved: true },
      headers: { Cookie: session.cookieHeader },
    });
    expect(approve.status).toBe(200);

    const tokenRes = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: da.device_code,
        client_id: client.client_id,
      },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; scope?: string };

    const rows = (await sql`
      SELECT scope FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)}
        AND token_type = 'access'
      LIMIT 1
    `) as unknown as Array<{ scope: string | null }>;
    expect(rows.length).toBe(1);
    expect((rows[0].scope ?? '').split(' ')).not.toContain('connections:token');
  });
});
