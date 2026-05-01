import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../__tests__/setup/test-fixtures';
import { getPrimaryAuthProfileForKind } from '../auth-profiles';
import { upsertConnectorDefinitionRecords } from '../connector-definition-install';

describe('auth profile selection', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('prefers a connector-specific oauth_app profile before provider fallback', async () => {
    const db = getTestDb();
    const org = await createTestOrganization({ name: 'OAuth App Preference Org' });

    await db`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key,
        profile_kind, status, auth_data, provider, created_at, updated_at
      ) VALUES (
        ${org.id}, 'youtube-google-app', 'YouTube Google App', 'youtube',
        'oauth_app', 'active', ${db.json({ GOOGLE_CLIENT_ID: 'youtube-client' })}, 'google',
        NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'
      ), (
        ${org.id}, 'gmail-google-app', 'Gmail Google App', 'google.gmail',
        'oauth_app', 'active', ${db.json({ GOOGLE_CLIENT_ID: 'gmail-client' })}, 'google',
        NOW(), NOW()
      )
    `;

    const profile = await getPrimaryAuthProfileForKind({
      organizationId: org.id,
      connectorKey: 'youtube',
      profileKind: 'oauth_app',
      provider: 'google',
    });

    expect(profile?.slug).toBe('youtube-google-app');
    expect(profile?.connector_key).toBe('youtube');
  });

  it('falls back to a provider-matched oauth_app profile when connector-specific one is missing', async () => {
    const db = getTestDb();
    const org = await createTestOrganization({ name: 'OAuth App Fallback Org' });

    await db`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key,
        profile_kind, status, auth_data, provider, created_at, updated_at
      ) VALUES (
        ${org.id}, 'gmail-google-app', 'Gmail Google App', 'google.gmail',
        'oauth_app', 'active', ${db.json({ GOOGLE_CLIENT_ID: 'gmail-client' })}, 'google',
        NOW(), NOW()
      )
    `;

    const profile = await getPrimaryAuthProfileForKind({
      organizationId: org.id,
      connectorKey: 'youtube',
      profileKind: 'oauth_app',
      provider: 'google',
    });

    expect(profile?.slug).toBe('gmail-google-app');
    expect(profile?.connector_key).toBe('google.gmail');
  });
});

describe('connector definition install', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('preserves login_enabled when updating an active connector definition', async () => {
    const db = getTestDb();
    const org = await createTestOrganization({ name: 'Connector Install Org' });

    await createTestConnectorDefinition({
      key: 'test.install',
      name: 'Install Me',
      version: '1.0.0',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'github', requiredScopes: ['read:user'] }],
      },
    });

    await db`
      UPDATE connector_definitions
      SET login_enabled = true
      WHERE organization_id = ${org.id}
        AND key = 'test.install'
    `;

    const result = await upsertConnectorDefinitionRecords({
      sql: db as never,
      organizationId: org.id,
      metadata: {
        key: 'test.install',
        name: 'Install Me',
        version: '1.1.0',
        description: 'Updated',
        authSchema: {
          methods: [{ type: 'oauth', provider: 'github', requiredScopes: ['read:user'] }],
        },
        feeds: null,
        actions: null,
        optionsSchema: null,
        faviconDomain: null,
        mcpConfig: null,
        openapiConfig: null,
      } as never,
      versionRecord: {
        compiledCode: 'module.exports = {}',
        compiledCodeHash: 'hash-1',
        sourceCode: 'export default {}',
        sourcePath: 'connectors/test.install.ts',
      },
    });

    const [row] = await db`
      SELECT version, login_enabled, status
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = 'test.install'
        AND status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    expect(result.updated).toBe(true);
    expect(row.version).toBe('1.1.0');
    expect(row.login_enabled).toBe(true);
    expect(row.status).toBe('active');
  });

  it('preserves login_enabled when reinstalling after an archived definition exists', async () => {
    const db = getTestDb();
    const org = await createTestOrganization({ name: 'Connector Reinstall Org' });

    await createTestConnectorDefinition({
      key: 'test.reinstall',
      name: 'Reinstall Me',
      version: '1.0.0',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'twitter', requiredScopes: ['users.read'] }],
      },
    });

    await db`
      UPDATE connector_definitions
      SET status = 'archived', login_enabled = true, updated_at = NOW()
      WHERE organization_id = ${org.id}
        AND key = 'test.reinstall'
    `;

    const result = await upsertConnectorDefinitionRecords({
      sql: db as never,
      organizationId: org.id,
      metadata: {
        key: 'test.reinstall',
        name: 'Reinstall Me',
        version: '2.0.0',
        description: 'Reinstalled',
        authSchema: {
          methods: [{ type: 'oauth', provider: 'twitter', requiredScopes: ['users.read'] }],
        },
        feeds: null,
        actions: null,
        optionsSchema: null,
        faviconDomain: null,
        mcpConfig: null,
        openapiConfig: null,
      } as never,
      versionRecord: {
        compiledCode: 'module.exports = {}',
        compiledCodeHash: 'hash-2',
        sourceCode: 'export default {}',
        sourcePath: 'connectors/test.reinstall.ts',
      },
    });

    const rows = await db`
      SELECT version, login_enabled, status
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = 'test.reinstall'
      ORDER BY updated_at DESC, id DESC
    `;

    expect(result.updated).toBe(false);
    expect(rows[0]?.version).toBe('2.0.0');
    expect(rows[0]?.login_enabled).toBe(true);
    expect(rows[0]?.status).toBe('active');
  });
});
