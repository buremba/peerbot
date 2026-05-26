/**
 * auth.md discovery surface + the full user_claimed loop.
 *
 * Discovery: the `agent_auth` block in AS metadata, the `auth_md` pointer in
 * protected-resource metadata, and the GET /auth.md walkthrough.
 *
 * Full loop: drives the user_claimed flow end to end against the mounted
 * oauthRoutes — register -> device_authorization -> device/email -> consent
 * approve (as the signed-in user) -> token poll yields a scoped credential.
 * `createTestSession` stands in for "user clicked the magic link and is now
 * signed in"; the magic-link verify -> session step is better-auth's own
 * tested code, and the device/email -> consent-link emission is covered by
 * device-email-claim.test.ts.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { oauthRoutes } from '../../../auth/oauth/routes';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const ORIGIN = 'http://localhost';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

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
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...opts?.headers },
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    TEST_ENV
  );
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await cleanupTestDatabase();
});

describe('auth.md discovery surface', () => {
  it('advertises the user_claimed agent_auth block in AS metadata', async () => {
    const res = await call(buildApp(), 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_auth?: {
        flows_supported: string[];
        claim_methods_supported: string[];
        claim_email_endpoint: string;
        device_authorization_endpoint: string;
        auth_md: string;
      };
    };
    expect(body.agent_auth).toBeDefined();
    expect(body.agent_auth?.flows_supported).toEqual(['user_claimed']);
    // Zero-touch ID-JAG is not offered yet.
    expect(body.agent_auth?.flows_supported).not.toContain('agent_verified');
    expect(body.agent_auth?.claim_methods_supported).toContain('email');
    expect(body.agent_auth?.claim_email_endpoint).toMatch(/\/oauth\/device\/email$/);
    expect(body.agent_auth?.device_authorization_endpoint).toMatch(
      /\/oauth\/device_authorization$/
    );
    expect(body.agent_auth?.auth_md).toMatch(/\/auth\.md$/);
  });

  it('points at auth.md from protected-resource metadata', async () => {
    const res = await call(buildApp(), 'GET', '/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_md?: string };
    expect(body.auth_md).toMatch(/\/auth\.md$/);
  });

  it('serves the auth.md walkthrough as markdown', async () => {
    const res = await call(buildApp(), 'GET', '/auth.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('# auth.md');
    expect(text).toContain('/oauth/device/email');
    expect(text).toContain('user_claimed');
  });
});

describe('user_claimed flow — full loop', () => {
  it('agent registers a user by email and collects a scoped credential after consent', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'Claim Org' });
    const user = await createTestUser({ name: 'Claim User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);

    // 1. Agent registers a device-code client (DCR).
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Claim Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // 2. Agent starts a device authorization, binding to the user's org.
    const da = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'mcp:read mcp:write',
        resource: `${ORIGIN}/mcp/${org.slug}`,
      },
    });
    expect(da.status).toBe(200);
    const { device_code, user_code } = (await da.json()) as {
      device_code: string;
      user_code: string;
    };

    // 3. Agent delivers the claim by email -> opaque 202.
    const email = await call(app, 'POST', '/oauth/device/email', {
      body: { user_code, email: user.email },
    });
    expect(email.status).toBe(202);

    // 4. User clicks the magic link (modelled by the session) and approves.
    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code, approved: true },
      headers: { Cookie: session.cookieHeader },
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()) as { status: string }).toEqual({ status: 'approved' });

    // 5. Agent polls and collects the scoped credential.
    const tokenRes = await call(app, 'POST', '/oauth/token', {
      body: { grant_type: DEVICE_GRANT, device_code, client_id: client.client_id },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; scope?: string };
    expect(tokens.access_token).toBeTruthy();
    expect((tokens.scope ?? '').split(' ')).toContain('mcp:read');
  });
});
