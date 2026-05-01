import { beforeEach, describe, expect, it } from 'vitest';
import { PersonalAccessTokenService } from '../tokens';
import { getTestDb, cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { post } from '../../__tests__/setup/test-helpers';

describe('org-scoped token creation route', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets an org owner with OAuth mcp:admin create a server PAT', async () => {
    const org = await createTestOrganization({ slug: 'token-route-org' });
    const user = await createTestUser({ email: 'token-owner@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: {
        name: 'prod-server',
        description: 'server token created from CLI OAuth login',
        scope: 'mcp:read mcp:write',
        expiresInDays: 30,
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.token.token).toMatch(/^owl_pat_/);
    expect(body.token.name).toBe('prod-server');
    expect(body.token.scope).toBe('mcp:read mcp:write');
    expect(body.token.expires_at).toBeTruthy();

    const verified = await new PersonalAccessTokenService(getTestDb()).verify(body.token.token);
    expect(verified?.userId).toBe(user.id);
    expect(verified?.organizationId).toBe(org.id);
    expect(verified?.scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('rejects OAuth tokens without mcp:admin scope', async () => {
    const org = await createTestOrganization({ slug: 'token-no-admin-scope' });
    const user = await createTestUser({ email: 'token-no-admin@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write profile:read',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: { name: 'should-not-create' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Token creation requires mcp:admin scope',
    });
  });

  it('rejects creating a PAT from an existing PAT', async () => {
    const org = await createTestOrganization({ slug: 'token-from-pat' });
    const user = await createTestUser({ email: 'token-pat@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id);

    const response = await post(`/api/${org.slug}/tokens`, {
      token: pat,
      body: { name: 'should-not-create' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Use `lobu login` with OAuth or a web session to create server tokens',
    });
  });
});
