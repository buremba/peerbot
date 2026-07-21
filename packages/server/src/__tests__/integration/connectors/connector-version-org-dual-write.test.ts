/**
 * connector_versions org-scoping dual-write (#2045 follow-up, PR 1 of the
 * isolation rollout).
 *
 * The table is transitioning from one global (connector_key, version)
 * namespace to shared bundled rows (organization_id IS NULL) + org-scoped
 * rows. In the dual-write phase the legacy shared row is still written and
 * stays authoritative for every read (all reads pin organization_id IS NULL);
 * org-supplied content is ADDITIONALLY copied onto the caller org's own row so
 * the later read cutover can prefer it.
 *
 * Locks in:
 * 1. 'organization' scope with content → shared row + org row, same bytes.
 * 2. 'shared' scope (bundled source_path pointer) → NULL row only.
 * 3. Content-empty 'organization' records (rollback / mcp_url shape) never
 *    create an org row — an empty org row would shadow the code-bearing
 *    shared row once reads prefer org rows.
 * 4. Two orgs writing different code under the same (key, version): the
 *    shared row keeps its legacy last-writer-wins behavior (unchanged, the
 *    pre-existing collision this rollout retires), but each org's OWN row
 *    keeps that org's bytes — the seed of isolation the read cutover serves.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestOrganization } from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';

function metadataFor(key: string, version: string): ConnectorMetadata {
  return {
    key,
    name: `Probe ${key}`,
    version,
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: null,
    behaviorEvents: null,
    optionsSchema: null,
  };
}

function contentRecord(marker: string) {
  return {
    compiledCode: `// compiled ${marker}`,
    compiledCodeHash: `hash-${marker}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${marker}`,
    sourcePath: null,
  };
}

const EMPTY_RECORD = {
  compiledCode: null,
  compiledCodeHash: null,
  compileConfigHash: null,
  sourceCode: null,
  sourcePath: null,
};

describe('connector_versions org-scoping dual-write', () => {
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgA = (await createTestOrganization({ name: 'Dual Write Org A' })).id;
    orgB = (await createTestOrganization({ name: 'Dual Write Org B' })).id;
  });

  async function rowsFor(key: string) {
    const sql = getTestDb();
    return await sql<
      {
        organization_id: string | null;
        version: string;
        source_code: string | null;
        source_path: string | null;
      }[]
    >`
      SELECT organization_id, version, source_code, source_path
      FROM connector_versions
      WHERE connector_key = ${key}
      ORDER BY organization_id NULLS FIRST
    `;
  }

  it("copies org-supplied content onto the org's own row next to the shared row", async () => {
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.dualwrite', '1.0.0'),
      versionRecord: contentRecord('a-1.0.0'),
      versionScope: 'organization',
    });

    const rows = await rowsFor('zz.dualwrite');
    expect(rows.map((r) => r.organization_id)).toEqual([null, orgA]);
    // Same bytes on both rows.
    expect(new Set(rows.map((r) => r.source_code))).toEqual(new Set(['// source a-1.0.0']));
  });

  it("keeps a bundled source_path pointer on the shared row only", async () => {
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.bundledptr', '1.0.0'),
      versionRecord: { ...EMPTY_RECORD, sourcePath: 'zz_bundledptr.ts' },
      versionScope: 'shared',
    });

    const rows = await rowsFor('zz.bundledptr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBeNull();
    expect(rows[0]?.source_path).toBe('zz_bundledptr.ts');
  });

  it('never creates an org row from a content-empty record (rollback / mcp_url shape)', async () => {
    // Seed the shared row with content, then send the all-NULL record shape
    // rollbackConnectorVersion uses (COALESCE keeps stored code).
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.emptyrec', '1.0.0'),
      versionRecord: contentRecord('seed-1.0.0'),
      versionScope: 'organization',
    });
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgB,
      metadata: metadataFor('zz.emptyrec', '1.0.0'),
      versionRecord: EMPTY_RECORD,
      versionScope: 'organization',
    });

    const rows = await rowsFor('zz.emptyrec');
    // Shared row + orgA's copy — but NO empty orgB row shadowing the code.
    expect(rows.map((r) => r.organization_id)).toEqual([null, orgA]);
    for (const r of rows) {
      expect(r.source_code).toBe('// source seed-1.0.0');
    }
  });

  it("keeps each org's bytes on its own row when two orgs collide on (key, version)", async () => {
    const key = 'zz.collide';
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor(key, '2.0.0'),
      versionRecord: contentRecord('a-2.0.0'),
      versionScope: 'organization',
    });
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgB,
      metadata: metadataFor(key, '2.0.0'),
      versionRecord: contentRecord('b-2.0.0'),
      versionScope: 'organization',
    });

    const rows = await rowsFor(key);
    const byOrg = new Map(rows.map((r) => [r.organization_id, r.source_code]));
    // Legacy shared row: last writer wins (pre-existing behavior, retired by
    // the read cutover — reads still pin it during dual-write).
    expect(byOrg.get(null)).toBe('// source b-2.0.0');
    // Each org's own row keeps its own bytes — the isolation seed.
    expect(byOrg.get(orgA)).toBe('// source a-2.0.0');
    expect(byOrg.get(orgB)).toBe('// source b-2.0.0');
  });
});
