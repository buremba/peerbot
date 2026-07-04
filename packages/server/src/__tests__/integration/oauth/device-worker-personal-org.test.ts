/**
 * Device clients (Owletto Mac app, Chrome extension, local `lobu run` worker)
 * ALWAYS bind to the user's personal org — never the active/selected org and
 * never the `resource` slug the client passes. Personal device data belongs in
 * the private workspace; team orgs reach a device by pinning a watcher /
 * connection to it (resolveDeviceClaimableOrgs), not by re-binding the token.
 *
 * These tests pin that invariant on the two server surfaces a device client
 * touches:
 *   - the device-code grant (`/oauth/device/approve` + `/oauth/token`): the
 *     resulting access token's `organization_id` MUST be the personal org,
 *     even when the client requested a team-org `resource` and the user is a
 *     multi-org member.
 *   - `/oauth/userinfo`: exposes `personal_org_slug` and marks the personal
 *     org with `personal: true`, so the Owletto menu bar can target it
 *     directly.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
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

async function markPersonalOrg(orgId: string, userId: string): Promise<void> {
  const sql = getTestDb();
  // Match personal-org-provisioning.ts: store the marker as plain JSON text
  // (the column is `text`; the read path casts with `(metadata::jsonb)->>`).
  const metadata = JSON.stringify({ personal_org_for_user_id: userId });
  await sql`
    UPDATE "organization"
    SET metadata = ${metadata}
    WHERE id = ${orgId}
  `;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

afterAll(async () => {
  // nothing to tear down — app is in-process
});

describe('device-worker grant always binds to the personal org', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('binds the access token to the personal org, ignoring a team-org resource + active org', async () => {
    const app = buildApp();
    const sql = getTestDb();

    // A user who belongs to TWO orgs: their personal one + a team org.
    const personalOrg = await createTestOrganization({ name: 'Personal' });
    const teamOrg = await createTestOrganization({ name: 'Team Workspace' });
    const user = await createTestUser({ name: 'Device User' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    await addUserToOrganization(user.id, teamOrg.id, 'owner');
    const session = await createTestSession(user.id);

    // Register a device-code client (the CLI / Mac app's DCR step).
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Owletto Mac test',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // The client requests device_worker:run AND points `resource` at the TEAM
    // org — exactly the lure that used to land devices in the wrong workspace.
    const deviceAuth = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token',
        resource: `${ORIGIN}/mcp/${teamOrg.slug}`,
      },
    });
    expect(deviceAuth.status).toBe(200);
    const da = (await deviceAuth.json()) as { device_code: string; user_code: string };

    // Approve — note NO organization_id is sent. The handler must force the
    // personal org; it must NOT bounce with org_selection_required.
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
    const tokens = (await tokenRes.json()) as { access_token: string };

    // The persisted access token is bound to the PERSONAL org, not the team org
    // the resource pointed at.
    const rows = (await sql`
      SELECT organization_id FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)}
        AND token_type = 'access'
      LIMIT 1
    `) as unknown as Array<{ organization_id: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0].organization_id).toBe(personalOrg.id);
    expect(rows[0].organization_id).not.toBe(teamOrg.id);
  });

  it('exposes personal_org_slug and marks the personal org on /oauth/userinfo', async () => {
    const app = buildApp();
    const sql = getTestDb();

    const personalOrg = await createTestOrganization({ name: 'Personal UserInfo' });
    const teamOrg = await createTestOrganization({ name: 'Team UserInfo' });
    const user = await createTestUser({ name: 'Info User' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    await addUserToOrganization(user.id, teamOrg.id, 'member');
    const session = await createTestSession(user.id);

    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Owletto Mac userinfo',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await reg.json()) as { client_id: string };

    const deviceAuth = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'device_worker:run mcp:read profile:read',
      },
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
    const tokens = (await tokenRes.json()) as { access_token: string };

    const infoRes = await call(app, 'GET', '/oauth/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as {
      personal_org_slug: string | null;
      organization_slug: string | null;
      organizations: { slug: string; personal?: boolean }[];
    };

    expect(info.personal_org_slug).toBe(personalOrg.slug);
    const personalEntry = info.organizations.find((o) => o.slug === personalOrg.slug);
    expect(personalEntry?.personal).toBe(true);
    // No other org is marked personal.
    expect(info.organizations.filter((o) => o.personal).length).toBe(1);
  });

  it('refuses a device-worker grant when the user has no personal org', async () => {
    const app = buildApp();

    // User with ONLY a team org (no personal-org marker anywhere).
    const teamOrg = await createTestOrganization({ name: 'Lonely Team' });
    const user = await createTestUser({ name: 'No Personal' });
    await addUserToOrganization(user.id, teamOrg.id, 'owner');
    const session = await createTestSession(user.id);

    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Owletto no-personal',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await reg.json()) as { client_id: string };

    const deviceAuth = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'device_worker:run mcp:read profile:read',
      },
    });
    const da = (await deviceAuth.json()) as { user_code: string };

    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: da.user_code, approved: true },
      headers: { Cookie: session.cookieHeader },
    });
    // No personal org to bind to → the device can't be paired.
    expect(approve.status).toBe(403);
  });
});
