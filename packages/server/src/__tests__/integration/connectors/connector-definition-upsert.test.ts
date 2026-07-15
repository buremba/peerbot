/**
 * upsertConnectorDefinitionRecords: the active-update (upgrade) path must still
 * persist the connector_versions row. Regression guard — an earlier refactor
 * early-returned after updating an active definition and skipped the version
 * upsert, leaving the definition pointing at a version with no executable
 * source record.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestOrganization } from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';

function metadataFor(version: string): ConnectorMetadata {
  return {
    key: 'upsert-probe',
    name: 'Upsert Probe',
    version,
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: null,
    optionsSchema: null,
  };
}

function versionRecordFor(version: string) {
  return {
    compiledCode: `// compiled ${version}`,
    compiledCodeHash: `hash-${version}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${version}`,
    sourcePath: `upsert-probe@${version}.ts`,
  };
}

describe('upsertConnectorDefinitionRecords', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Upsert Probe Org' });
    orgId = org.id;
  });

  it('persists the connector_versions row on both the initial install and the upgrade', async () => {
    const sql = getTestDb();

    // Initial install → INSERT branch.
    const first = await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor('1.0.0'),
      versionRecord: versionRecordFor('1.0.0'),
    });
    expect(first.updated).toBe(false);

    // Re-install a new version → active-UPDATE branch. This must STILL write the
    // connector_versions row for 1.1.0 (the regression: early-return skipped it).
    const second = await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor('1.1.0'),
      versionRecord: versionRecordFor('1.1.0'),
    });
    expect(second.updated).toBe(true);

    const versions = await sql<{ version: string; source_code: string | null }[]>`
      SELECT version, source_code FROM connector_versions
      WHERE connector_key = 'upsert-probe'
      ORDER BY version
    `;
    const byVersion = new Map(versions.map((v) => [v.version, v.source_code]));
    // Both versions' executable source rows exist — the definition never points
    // at a version with no source record.
    expect(byVersion.has('1.0.0')).toBe(true);
    expect(byVersion.get('1.1.0')).toBe('// source 1.1.0');

    // The definition itself reflects the upgrade.
    const def = await sql<{ version: string }[]>`
      SELECT version FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = 'upsert-probe' AND status = 'active'
    `;
    expect(def[0]?.version).toBe('1.1.0');
  });
});
