/**
 * connector_versions org-scoped writes (#2045 follow-up, step 3 of the
 * isolation rollout).
 *
 * End state: org-supplied content lands ONLY on the caller org's own
 * (organization_id, connector_key, version) row; the shared
 * organization_id-IS-NULL namespace holds bundled catalog pointers alone.
 * Locks in:
 * 1. 'organization' scope with content → the org's row, NO shared row.
 * 2. 'shared' scope (bundled source_path pointer) → NULL row only.
 * 3. Content-empty 'organization' records: the rollback shape (rows exist)
 *    writes nothing; the first-mcp_url-install shape (no rows at all)
 *    creates a marker org row.
 * 4. Two orgs writing different code under the same (key, version): two
 *    private rows, each org keeps its own bytes, no shared surface.
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

describe('connector_versions org-scoped writes', () => {
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgA = (await createTestOrganization({ name: 'Org Write Org A' })).id;
    orgB = (await createTestOrganization({ name: 'Org Write Org B' })).id;
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

  it("writes org-supplied content to the org's own row only — never the shared namespace", async () => {
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.orgwrite', '1.0.0'),
      versionRecord: contentRecord('a-1.0.0'),
      versionScope: 'organization',
    });

    const rows = await rowsFor('zz.orgwrite');
    expect(rows.map((r) => r.organization_id)).toEqual([orgA]);
    expect(rows[0]?.source_code).toBe('// source a-1.0.0');
  });

  it('keeps a bundled source_path pointer on the shared row only', async () => {
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

  it('content-empty records: rollback shape writes nothing, first-install shape creates a marker', async () => {
    // Rollback shape: rows for the pair exist → the all-NULL record must not
    // create anything (an empty org row would shadow a code-bearing row).
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.emptyrec', '1.0.0'),
      versionRecord: contentRecord('seed-1.0.0'),
      versionScope: 'organization',
    });
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgA,
      metadata: metadataFor('zz.emptyrec', '1.0.0'),
      versionRecord: EMPTY_RECORD,
      versionScope: 'organization',
    });
    const kept = await rowsFor('zz.emptyrec');
    expect(kept.map((r) => [r.organization_id, r.source_code])).toEqual([
      [orgA, '// source seed-1.0.0'],
    ]);
    // Cross-org: B's all-NULL upsert against a pair only A holds privately
    // creates B's OWN marker (isolated namespaces — B legitimately installing
    // an mcp connector under a key A also uses) and never touches A's row.
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgB,
      metadata: metadataFor('zz.emptyrec', '1.0.0'),
      versionRecord: EMPTY_RECORD,
      versionScope: 'organization',
    });
    const afterB = new Map(
      (await rowsFor('zz.emptyrec')).map((r) => [r.organization_id, r.source_code])
    );
    expect(afterB.size).toBe(2);
    expect(afterB.get(orgA)).toBe('// source seed-1.0.0');
    expect(afterB.get(orgB)).toBeNull();

    // First-install shape (mcp_url): no rows at all → a marker org row.
    await upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgB,
      metadata: metadataFor('zz.mcpmarker', '1.0.0'),
      versionRecord: EMPTY_RECORD,
      versionScope: 'organization',
    });
    const marker = await rowsFor('zz.mcpmarker');
    expect(marker.map((r) => r.organization_id)).toEqual([orgB]);
    expect(marker[0]?.source_code).toBeNull();
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
    // No shared surface at all — the pre-rollout last-writer-wins clobber row
    // no longer exists.
    expect(byOrg.has(null)).toBe(false);
    expect(byOrg.get(orgA)).toBe('// source a-2.0.0');
    expect(byOrg.get(orgB)).toBe('// source b-2.0.0');
  });
});
