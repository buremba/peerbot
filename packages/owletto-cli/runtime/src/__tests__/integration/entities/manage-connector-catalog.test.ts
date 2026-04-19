import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function buildConnectorSource(params: { key: string; nameExpression: string; version?: string }) {
  return `
export class TestConnectorRuntime {
  definition = {
    key: ${JSON.stringify(params.key)},
    name: ${params.nameExpression},
    description: "Installed by catalog tests",
    version: ${JSON.stringify(params.version ?? '1.0.0')},
    authSchema: { methods: [] },
    feeds: { default: {} },
    actions: {},
    optionsSchema: null,
  };

  async sync() {
    return { items: [] };
  }

  async execute() {
    return { ok: true };
  }
}
`;
}

describe('Manage Connector Catalog', () => {
  let organizationId: string;
  let token: string;
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Connector Catalog Org' });
    organizationId = org.id;
    const user = await createTestUser({ email: 'connector-catalog@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;
  });

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createCatalogDir(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'owletto-connector-catalog-'));
    tmpDirs.push(dir);

    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents, 'utf-8');
    }

    return dir;
  }

  it('lists only installed connector definitions by default', async () => {
    const catalogDir = await createCatalogDir({
      'catalog_only.ts': buildConnectorSource({
        key: 'test.catalog.only',
        nameExpression: JSON.stringify('Catalog Only Connector'),
      }),
    });

    await createTestConnectorDefinition({
      key: 'test.installed.only',
      name: 'Installed Only Connector',
      organization_id: organizationId,
    });

    const result = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'list_connector_definitions',
      },
      { token, env: { CONNECTOR_CATALOG_URIS: catalogDir } }
    );

    expect(result.connector_definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'test.installed.only',
          name: 'Installed Only Connector',
          installed: true,
          installable: false,
          catalog_origin: 'org',
        }),
      ])
    );
    expect(
      result.connector_definitions.find((item: { key: string }) => item.key === 'test.catalog.only')
    ).toBeUndefined();
  });

  it('merges installed and installable connectors and prefers installed rows on key collisions', async () => {
    const catalogDir = await createCatalogDir({
      'catalog_only.ts': buildConnectorSource({
        key: 'test.catalog.merge',
        nameExpression: JSON.stringify('Catalog Merge Connector'),
      }),
      'duplicate.ts': buildConnectorSource({
        key: 'test.catalog.duplicate',
        nameExpression: JSON.stringify('Catalog Duplicate Connector'),
      }),
      'helper.ts': 'export const helper = true;\n',
    });

    const org = await createTestOrganization({ name: 'Merge Org' });
    const user = await createTestUser({ email: 'merge@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const mergeToken = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    await createTestConnectorDefinition({
      key: 'test.catalog.duplicate',
      name: 'Installed Duplicate Connector',
      organization_id: org.id,
    });

    const result = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'list_connector_definitions',
        include_installable: true,
      },
      { token: mergeToken, env: { CONNECTOR_CATALOG_URIS: `git://ignored,${catalogDir}` } }
    );

    expect(result.connector_definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'test.catalog.merge',
          installed: false,
          installable: true,
          catalog_origin: 'catalog',
          source_uri: expect.stringMatching(/^file:\/\//),
        }),
        expect.objectContaining({
          key: 'test.catalog.duplicate',
          name: 'Installed Duplicate Connector',
          installed: true,
          installable: false,
          catalog_origin: 'org',
        }),
      ])
    );

    expect(
      result.connector_definitions.filter(
        (item: { key: string }) => item.key === 'test.catalog.duplicate'
      )
    ).toHaveLength(1);
    expect(
      result.connector_definitions.find((item: { key: string }) => item.key === 'helper')
    ).toBeUndefined();
  });

  it('installs a connector from source_uri and preserves relative imports', async () => {
    const catalogDir = await createCatalogDir({
      'shared.ts': `export const connectorName = 'Catalog Install Connector';\n`,
      'catalog_install.ts': `
import { connectorName } from './shared';
${buildConnectorSource({
  key: 'test.catalog.install',
  nameExpression: 'connectorName',
})}
`,
    });

    const connectorFile = join(catalogDir, 'catalog_install.ts');
    const installed = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'install_connector',
        source_uri: pathToFileURL(connectorFile).toString(),
      },
      { token }
    );

    expect(installed.action).toBe('install_connector');
    expect(installed.connector_key).toBe('test.catalog.install');

    const listed = await mcpToolsCall<any>(
      'manage_connections',
      {
        action: 'list_connector_definitions',
      },
      { token }
    );

    expect(listed.connector_definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'test.catalog.install',
          name: 'Catalog Install Connector',
          source_uri: expect.stringMatching(/^file:\/\//),
        }),
      ])
    );
  });
});
