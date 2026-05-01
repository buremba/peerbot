/**
 * Layer 1 — Device Auth Integration Test
 *
 * Exercises the full RFC 8628 device-code OAuth flow against the running
 * Owletto backend. No LLM needed — pure HTTP calls.
 *
 * Prerequisites:
 *   - docker compose up (at least: app, redis)
 *   - DATABASE_URL in env (or .env)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_URL,
  addUserToOrg,
  cleanupTestData,
  closeDb,
  createTestOrg,
  oauthApproveDevice,
  oauthDeviceAuthorize,
  oauthExchangeDeviceCode,
  oauthRefreshToken,
  oauthRegisterClient,
  type SignedUpUser,
  signUpTestUser,
  type TestOrg,
} from './helpers';

let org: TestOrg;
let signedUp: SignedUpUser;

beforeAll(async () => {
  // Verify the app is reachable
  try {
    const health = await fetch(`${APP_URL}/health`);
    if (!health.ok) throw new Error(`Health check returned ${health.status}`);
  } catch (err) {
    throw new Error(`Cannot reach app at ${APP_URL}. Is docker compose up?\n${err}`);
  }

  // Sign up a real user via Better Auth (gives us a valid session cookie)
  signedUp = await signUpTestUser();

  // Create a test org and add the user to it
  org = await createTestOrg();
  await addUserToOrg(signedUp.userId, org.id, 'owner');
});

afterAll(async () => {
  await cleanupTestData();
  await closeDb();
});

describe('OAuth device-code flow', () => {
  let clientId: string;
  let clientSecret: string | undefined;
  let deviceCode: string;
  let userCode: string;

  it('registers a dynamic OAuth client', async () => {
    const client = await oauthRegisterClient('mcp:read mcp:write');
    clientId = client.clientId;
    clientSecret = client.clientSecret;

    expect(clientId).toBeTruthy();
    expect(typeof clientId).toBe('string');
  });

  it('starts device authorization and gets user_code', async () => {
    const authz = await oauthDeviceAuthorize(
      clientId,
      'mcp:read mcp:write',
      `${APP_URL}/${org.slug}`
    );

    deviceCode = authz.device_code;
    userCode = authz.user_code;

    expect(deviceCode).toBeTruthy();
    expect(userCode).toBeTruthy();
    expect(authz.verification_uri).toContain('/oauth/device');
    expect(authz.expires_in).toBeGreaterThan(0);
  });

  it('returns authorization_pending before approval', async () => {
    const res = await fetch(`${APP_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('authorization_pending');
  });

  it('approves the device code with a session cookie', async () => {
    await oauthApproveDevice(userCode, signedUp.cookieHeader, org.id);
  });

  it('exchanges device_code for access + refresh tokens', async () => {
    const tokens = await oauthExchangeDeviceCode(clientId, deviceCode, clientSecret);

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(tokens.refresh_token).toBeTruthy();
  });

  it('refreshes the access token', async () => {
    // Full cycle: register → authorize → approve → exchange → refresh
    const client = await oauthRegisterClient('mcp:read mcp:write');
    const authz = await oauthDeviceAuthorize(
      client.clientId,
      'mcp:read mcp:write',
      `${APP_URL}/${org.slug}`
    );
    await oauthApproveDevice(authz.user_code, signedUp.cookieHeader, org.id);
    const tokens = await oauthExchangeDeviceCode(
      client.clientId,
      authz.device_code,
      client.clientSecret
    );

    expect(tokens.refresh_token).toBeTruthy();

    const refreshed = await oauthRefreshToken(
      client.clientId,
      tokens.refresh_token!,
      client.clientSecret
    );

    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.token_type.toLowerCase()).toBe('bearer');
  });

  it('validates the access token against MCP userinfo', async () => {
    const client = await oauthRegisterClient('mcp:read mcp:write profile:read');
    const authz = await oauthDeviceAuthorize(
      client.clientId,
      'mcp:read mcp:write profile:read',
      `${APP_URL}/${org.slug}`
    );
    await oauthApproveDevice(authz.user_code, signedUp.cookieHeader, org.id);
    const tokens = await oauthExchangeDeviceCode(
      client.clientId,
      authz.device_code,
      client.clientSecret
    );

    const res = await fetch(`${APP_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    expect(res.ok).toBe(true);
    const userInfo = (await res.json()) as { sub: string; email?: string };
    expect(userInfo.sub).toBe(signedUp.userId);
  });
});
