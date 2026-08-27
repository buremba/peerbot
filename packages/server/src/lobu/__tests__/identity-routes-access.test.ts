import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

let stashOnEntry: typeof authStash;

async function request(body: Record<string, unknown>) {
  const { identityRoutes } = await import('../identity-routes');
  return identityRoutes.request('/rekey', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  stashOnEntry ??= { ...authStash };
  authStash.user = {
    id: 'u1',
    name: 'Test',
    email: 'u1@test',
    emailVerified: true,
  };
  authStash.organizationId = 'org-identity-rekey';
  authStash.authSource = 'session';
  authStash.mcpAuthInfo = null;
  authStash.memberRole = 'owner';
});

afterAll(() => {
  if (stashOnEntry) Object.assign(authStash, stashOnEntry);
});

describe('identity rekey route access', () => {
  test('rejects an owner PAT without mcp:admin', async () => {
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read'] };
    const response = await request({ namespace: 'erp_customer', mapping: {} });
    expect(response.status).toBe(403);
  });

  test('rejects a member session', async () => {
    authStash.memberRole = 'member';
    const response = await request({ namespace: 'erp_customer', mapping: {} });
    expect(response.status).toBe(403);
  });

  test('allows an owner PAT with mcp:admin through to request validation', async () => {
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:admin'] };
    const response = await request({});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Identity namespace is required.'
    );
  });

  test('allows an owner session through to request validation', async () => {
    const response = await request({});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Identity namespace is required.'
    );
  });
});
