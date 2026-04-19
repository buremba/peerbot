import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Manage Connections - Auth Profiles', () => {
  let token: string;
  let org: Awaited<ReturnType<typeof createTestOrganization>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Auth Profiles Org' });
    const user = await createTestUser({ email: 'auth-profiles@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    await createTestConnectorDefinition({
      key: 'test.auth.profiles',
      name: 'Test Auth Profiles Connector',
      version: '1.0.0',
      organization_id: org.id,
      feeds_schema: {
        tweets: {
          key: 'tweets',
          name: 'Tweets',
          configSchema: {
            type: 'object',
            required: ['search_query'],
            properties: {
              search_query: { type: 'string' },
            },
          },
        },
      },
      auth_schema: {
        methods: [
          {
            type: 'env_keys',
            required: true,
            fields: [{ key: 'X_COOKIES', label: 'X Cookies', required: true, secret: true }],
          },
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: ['email'],
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          },
        ],
      },
    });

    await createTestConnectorDefinition({
      key: 'test.browser.profiles',
      name: 'Test Browser Profiles Connector',
      version: '1.0.0',
      organization_id: org.id,
      feeds_schema: {
        timeline: {
          key: 'timeline',
          name: 'Timeline',
          configSchema: {
            type: 'object',
            required: ['search_query'],
            properties: {
              search_query: { type: 'string' },
            },
          },
        },
      },
      auth_schema: {
        methods: [
          {
            type: 'browser',
            capture: 'cli',
            description: 'Capture cookies from a local browser profile',
          },
        ],
      },
    });

    await createTestConnectorDefinition({
      key: 'test.browser.preferred',
      name: 'Test Browser Preferred Connector',
      version: '1.0.0',
      organization_id: org.id,
      feeds_schema: {
        timeline: {
          key: 'timeline',
          name: 'Timeline',
          configSchema: {
            type: 'object',
            required: ['search_query'],
            properties: {
              search_query: { type: 'string' },
            },
          },
        },
      },
      auth_schema: {
        methods: [
          {
            type: 'browser',
            capture: 'cli',
            description: 'Preferred browser auth for scraping.',
          },
          {
            type: 'oauth',
            provider: 'linkedin',
            requiredScopes: ['openid', 'profile', 'email'],
            loginScopes: ['openid', 'profile', 'email'],
            authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
            tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
            userinfoUrl: 'https://api.linkedin.com/v2/userinfo',
          },
        ],
      },
    });
  });

  it('creates reusable env auth profiles and uses them by slug when creating connections', async () => {
    const authProfileResult = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
        display_name: 'Primary X Cookies',
        slug: 'primary-x-cookies',
        credentials: {
          X_COOKIES: 'ct0=test_ct0; auth_token=test_auth_token',
        },
      },
      { token }
    );

    expect(authProfileResult.action).toBe('create_auth_profile');
    expect(authProfileResult.auth_profile.slug).toBe('primary-x-cookies');
    expect(authProfileResult.auth_profile.profile_kind).toBe('env');

    const createdOne = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.auth.profiles',
        display_name: 'Tweets Search One',
        auth_profile_slug: 'primary-x-cookies',
        config: { search_query: 'from:first' },
      },
      { token }
    );

    const createdTwo = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.auth.profiles',
        display_name: 'Tweets Search Two',
        auth_profile_slug: 'primary-x-cookies',
        config: { search_query: 'from:second' },
      },
      { token }
    );

    expect(createdOne.action).toBe('create');
    expect(createdTwo.action).toBe('create');
    expect(createdOne.connection.auth_profile_slug).toBe('primary-x-cookies');
    expect(createdTwo.connection.auth_profile_slug).toBe('primary-x-cookies');

    const tested = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'test',
        connection_id: Number(createdOne.connection.id),
      },
      { token }
    );

    expect(tested.action).toBe('test');
    expect(tested.status).toBe('ok');
    expect(tested.message).toContain('primary-x-cookies');
  });

  it('lists auth profiles and returns OAuth account connect URLs', async () => {
    const appProfileResult = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'oauth_app',
        display_name: 'Google App',
        slug: 'google-app',
        credentials: {
          GOOGLE_CLIENT_ID: 'client-id',
          GOOGLE_CLIENT_SECRET: 'client-secret',
        },
      },
      { token }
    );

    expect(appProfileResult.action).toBe('create_auth_profile');
    expect(appProfileResult.auth_profile.slug).toBe('google-app');
    expect(appProfileResult.auth_profile.provider).toBe('google');

    const accountProfileResult = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'oauth_account',
        display_name: 'Google Workspace Account',
        slug: 'google-workspace',
      },
      { token }
    );

    expect(accountProfileResult.action).toBe('create_auth_profile');
    expect(accountProfileResult.pending_slug).toBe('google-workspace');
    expect(accountProfileResult.connect_url).toContain('/connect/');
    expect(accountProfileResult.connect_token).toBeTruthy();

    const listed = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'list_auth_profiles',
        connector_key: 'test.auth.profiles',
      },
      { token }
    );

    const slugs = listed.auth_profiles.map((profile: { slug: string }) => profile.slug);
    expect(slugs).toContain('primary-x-cookies');
    expect(slugs).toContain('google-app');
  });

  it('creates browser session profiles and activates linked connections after cookie capture', async () => {
    const createdProfile = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.browser.profiles',
        profile_kind: 'browser_session',
        display_name: 'Primary Browser Session',
        slug: 'primary-browser-session',
      },
      { token }
    );

    expect(createdProfile.action).toBe('create_auth_profile');
    expect(createdProfile.auth_profile.slug).toBe('primary-browser-session');
    expect(createdProfile.auth_profile.status).toBe('pending_auth');

    const createdConnection = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.browser.profiles',
        display_name: 'Browser Timeline',
        auth_profile_slug: 'primary-browser-session',
        config: { search_query: 'browser-auth' },
      },
      { token }
    );

    expect(createdConnection.action).toBe('create');
    expect(createdConnection.connection.status).toBe('pending_auth');
    expect(createdConnection.connection.auth_profile_slug).toBe('primary-browser-session');

    const updatedProfile = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'update_auth_profile',
        auth_profile_slug: 'primary-browser-session',
        auth_data: {
          cookies: [
            {
              name: 'auth_token',
              value: 'test-auth-token',
              domain: '.x.com',
              path: '/',
              expires: Math.floor(Date.now() / 1000) + 86400,
              httpOnly: true,
              secure: true,
            },
          ],
          captured_at: new Date().toISOString(),
          captured_via: 'test',
        },
      },
      { token }
    );

    expect(updatedProfile.action).toBe('update_auth_profile');
    expect(updatedProfile.auth_profile.status).toBe('active');
    expect(updatedProfile.auth_profile.cookie_count).toBe(1);

    const testedProfile = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'test_auth_profile',
        auth_profile_slug: 'primary-browser-session',
      },
      { token }
    );

    expect(testedProfile.action).toBe('test_auth_profile');
    expect(testedProfile.status).toBe('ok');
    expect(testedProfile.auth_cookie_name).toBe('auth_token');

    const fetchedConnection = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'get',
        connection_id: Number(createdConnection.connection.id),
      },
      { token }
    );

    expect(fetchedConnection.connection.status).toBe('active');
    expect(fetchedConnection.connection.auth_profile_kind).toBe('browser_session');

    const testedConnection = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'test',
        connection_id: Number(createdConnection.connection.id),
      },
      { token }
    );

    expect(testedConnection.action).toBe('test');
    expect(testedConnection.status).toBe('ok');
    expect(testedConnection.message).toContain('auth_token');
  });

  it('prefers browser auth over oauth when browser is listed first in the connector schema', async () => {
    const result = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'connect',
        connector_key: 'test.browser.preferred',
        display_name: 'Browser Preferred Timeline',
        config: { search_query: 'linkedin' },
      },
      { token }
    );

    expect(result.error).toContain('Select or create a browser auth profile');
    expect(result.connect_url).toBeUndefined();
  });

  it('updates auth profile display name and credentials', async () => {
    const updated = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'update_auth_profile',
        auth_profile_slug: 'primary-x-cookies',
        display_name: 'Updated X Cookies',
        credentials: {
          X_COOKIES: 'ct0=updated_ct0; auth_token=updated_auth_token',
        },
      },
      { token }
    );

    expect(updated.action).toBe('update_auth_profile');
    expect(updated.auth_profile.display_name).toBe('Updated X Cookies');
    expect(updated.auth_profile.slug).toBe('primary-x-cookies');
  });

  it('prevents deleting auth profile used by active connections without force', async () => {
    const result = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'delete_auth_profile',
        auth_profile_slug: 'primary-x-cookies',
      },
      { token }
    );

    expect(result.error).toContain('is used by');
    expect(result.error).toContain('active connection');
  });

  it('deletes auth profile used by connections when force is true', async () => {
    // Create a standalone profile to test force deletion
    await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
        display_name: 'Deletable Profile',
        slug: 'deletable-profile',
        credentials: { X_COOKIES: 'to-be-deleted' },
      },
      { token }
    );

    const conn = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.auth.profiles',
        display_name: 'Will Lose Auth',
        auth_profile_slug: 'deletable-profile',
        config: { search_query: 'test' },
      },
      { token }
    );

    const forceResult = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'delete_auth_profile',
        auth_profile_slug: 'deletable-profile',
        force: true,
      },
      { token }
    );

    expect(forceResult.action).toBe('delete_auth_profile');
    expect(forceResult.deleted).toBe(true);

    // Verify connection still exists but without auth profile
    const fetched = await mcpToolsCall<any>(
      'manage_connections',
      { action: 'get', connection_id: Number(conn.connection.id) },
      { token }
    );
    expect(fetched.connection.auth_profile_slug).toBeNull();
  });

  it('deletes unused auth profile without force', async () => {
    await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
        display_name: 'Unused Profile',
        slug: 'unused-profile',
        credentials: { X_COOKIES: 'unused' },
      },
      { token }
    );

    const result = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'delete_auth_profile',
        auth_profile_slug: 'unused-profile',
      },
      { token }
    );

    expect(result.action).toBe('delete_auth_profile');
    expect(result.deleted).toBe(true);

    // Verify it's gone
    const listed = await mcpToolsCall<any>(
      'manage_auth_profiles',
      { action: 'list_auth_profiles', connector_key: 'test.auth.profiles' },
      { token }
    );
    const slugs = listed.auth_profiles.map((p: { slug: string }) => p.slug);
    expect(slugs).not.toContain('unused-profile');
  });

  it('rejects creating auth profile without credentials', async () => {
    const result = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
        display_name: 'No Creds Profile',
        credentials: {},
      },
      { token }
    );

    expect(result.error).toContain('Credentials are required');
    expect(result.error).toContain('X_COOKIES');
  });

  it('rejects updating connection with revoked auth profile', async () => {
    // Create a profile and then revoke it
    await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'create_auth_profile',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
        display_name: 'Revoked Profile',
        slug: 'revoked-profile',
        credentials: { X_COOKIES: 'will-revoke' },
      },
      { token }
    );

    await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'update_auth_profile',
        auth_profile_slug: 'revoked-profile',
        status: 'revoked',
      },
      { token }
    );

    // Get the first connection created in the test suite
    const listed = await mcpToolsCall<any>('manage_connections', { action: 'list' }, { token });
    const connectionId = Number(listed.connections[0].id);

    const result = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'update',
        connection_id: connectionId,
        auth_profile_slug: 'revoked-profile',
      },
      { token }
    );

    expect(result.error).toContain('revoked');
  });

  it('does not auto-create feeds during connection creation', async () => {
    const created = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.auth.profiles',
        display_name: 'Default No Feed Connection',
        auth_profile_slug: 'primary-x-cookies',
      },
      { token }
    );

    expect(created.action).toBe('create');

    const feedsResult = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'list_feeds',
        connection_id: Number(created.connection.id),
      },
      { token }
    );

    expect(feedsResult.feeds).toEqual([]);
  });

  it('rejects feed-scoped config during connection creation', async () => {
    const result = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'create',
        connector_key: 'test.auth.profiles',
        display_name: 'Bad Feed Config Connection',
        auth_profile_slug: 'primary-x-cookies',
        config: { search_query: 'config-propagation-test' },
      },
      { token }
    );

    expect(result.error).toContain('Feed-scoped config belongs on feeds');
  });

  it('filters auth profiles by profile_kind', async () => {
    const envOnly = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'list_auth_profiles',
        connector_key: 'test.auth.profiles',
        profile_kind: 'env',
      },
      { token }
    );

    for (const profile of envOnly.auth_profiles) {
      expect(profile.profile_kind).toBe('env');
    }

    const oauthAppOnly = await mcpToolsCall<any>(
      'manage_auth_profiles',
      {
        action: 'list_auth_profiles',
        connector_key: 'test.auth.profiles',
        profile_kind: 'oauth_app',
      },
      { token }
    );

    for (const profile of oauthAppOnly.auth_profiles) {
      expect(profile.profile_kind).toBe('oauth_app');
    }
  });
});
