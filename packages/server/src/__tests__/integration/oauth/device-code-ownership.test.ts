import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestDeviceCode,
  createTestOAuthClient,
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
  options?: { body?: unknown; cookie?: string }
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(options?.cookie ? { Cookie: options.cookie } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
    TEST_ENV
  );
}

async function createPendingCode() {
  const client = await createTestOAuthClient({
    grant_types: [DEVICE_GRANT, 'refresh_token'],
  });
  return createTestDeviceCode(client.client_id, { scope: 'profile:read' });
}

async function readDeviceCode(userCode: string) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT user_id, status
    FROM oauth_device_codes
    WHERE user_code = ${userCode}
  `) as unknown as Array<{ user_id: string | null; status: string }>;
  return rows[0];
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

beforeEach(async () => {
  await cleanupTestDatabase();
});

describe('OAuth device verifier ownership', () => {
  it('claims a pending code for one user and lets that user verify it idempotently', async () => {
    const app = buildApp();
    const user = await createTestUser({ name: 'Verifier' });
    const session = await createTestSession(user.id);
    const device = await createPendingCode();
    const path = `/oauth/device/info?user_code=${device.userCode}`;

    const first = await call(app, 'GET', path, { cookie: session.cookieHeader });
    const second = await call(app, 'GET', path, { cookie: session.cookieHeader });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await readDeviceCode(device.userCode)).toEqual({
      user_id: user.id,
      status: 'pending',
    });
  });

  it('allows only one of two concurrent users to claim a code', async () => {
    const app = buildApp();
    const firstUser = await createTestUser({ name: 'First verifier' });
    const secondUser = await createTestUser({ name: 'Second verifier' });
    const firstSession = await createTestSession(firstUser.id);
    const secondSession = await createTestSession(secondUser.id);
    const device = await createPendingCode();
    const path = `/oauth/device/info?user_code=${device.userCode}`;

    const responses = await Promise.all([
      call(app, 'GET', path, { cookie: firstSession.cookieHeader }),
      call(app, 'GET', path, { cookie: secondSession.cookieHeader }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const winner = responses[0].status === 200 ? firstUser : secondUser;
    expect((await readDeviceCode(device.userCode))?.user_id).toBe(winner.id);
    const rejected = responses.find((response) => response.status === 400);
    expect(await rejected?.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid or expired user code',
    });
  });

  it.each([
    { approved: true, finalStatus: 'approved' },
    { approved: false, finalStatus: 'denied' },
  ])(
    'rejects an unverified consent decision before it can set status=$finalStatus',
    async ({ approved }) => {
      const app = buildApp();
      const user = await createTestUser({ name: 'Direct submitter' });
      const session = await createTestSession(user.id);
      const device = await createPendingCode();

      const response = await call(app, 'POST', '/oauth/device/approve', {
        cookie: session.cookieHeader,
        body: { user_code: device.userCode, approved },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Invalid or expired user code',
      });
      expect(await readDeviceCode(device.userCode)).toEqual({
        user_id: null,
        status: 'pending',
      });
    }
  );

  it.each([
    { approved: true, finalStatus: 'approved' },
    { approved: false, finalStatus: 'denied' },
  ])(
    'lets only the verifier set status=$finalStatus',
    async ({ approved, finalStatus }) => {
      const app = buildApp();
      const verifier = await createTestUser({ name: 'Verifier' });
      const attacker = await createTestUser({ name: 'Other user' });
      const verifierSession = await createTestSession(verifier.id);
      const attackerSession = await createTestSession(attacker.id);
      const device = await createPendingCode();
      const infoPath = `/oauth/device/info?user_code=${device.userCode}`;

      const verified = await call(app, 'GET', infoPath, {
        cookie: verifierSession.cookieHeader,
      });
      expect(verified.status).toBe(200);

      const hidden = await call(app, 'GET', infoPath, {
        cookie: attackerSession.cookieHeader,
      });
      expect(hidden.status).toBe(400);

      const rejected = await call(app, 'POST', '/oauth/device/approve', {
        cookie: attackerSession.cookieHeader,
        body: { user_code: device.userCode, approved },
      });
      expect(rejected.status).toBe(400);
      expect(await readDeviceCode(device.userCode)).toEqual({
        user_id: verifier.id,
        status: 'pending',
      });

      const accepted = await call(app, 'POST', '/oauth/device/approve', {
        cookie: verifierSession.cookieHeader,
        body: { user_code: device.userCode, approved },
      });
      expect(accepted.status).toBe(200);
      expect(await readDeviceCode(device.userCode)).toEqual({
        user_id: verifier.id,
        status: finalStatus,
      });
    }
  );

  it('cannot exchange a token attributed to a user who lost the verifier claim', async () => {
    const app = buildApp();
    const verifier = await createTestUser({ name: 'Token verifier' });
    const attacker = await createTestUser({ name: 'Token attacker' });
    const verifierSession = await createTestSession(verifier.id);
    const attackerSession = await createTestSession(attacker.id);
    const client = await createTestOAuthClient({
      grant_types: [DEVICE_GRANT, 'refresh_token'],
    });
    const device = await createTestDeviceCode(client.client_id, { scope: 'profile:read' });

    const info = await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${device.userCode}`,
      { cookie: verifierSession.cookieHeader }
    );
    expect(info.status).toBe(200);

    const rejected = await call(app, 'POST', '/oauth/device/approve', {
      cookie: attackerSession.cookieHeader,
      body: { user_code: device.userCode, approved: true },
    });
    expect(rejected.status).toBe(400);

    const pending = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    });
    expect(pending.status).toBe(400);
    expect((await pending.json()) as { error: string }).toMatchObject({
      error: 'authorization_pending',
    });

    const approved = await call(app, 'POST', '/oauth/device/approve', {
      cookie: verifierSession.cookieHeader,
      body: { user_code: device.userCode, approved: true },
    });
    expect(approved.status).toBe(200);

    const exchanged = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string };
    const sql = getTestDb();
    const rows = (await sql`
      SELECT user_id FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)}
        AND token_type = 'access'
    `) as unknown as Array<{ user_id: string }>;
    expect(rows).toEqual([{ user_id: verifier.id }]);
    expect(rows[0]?.user_id).not.toBe(attacker.id);
  });
});
