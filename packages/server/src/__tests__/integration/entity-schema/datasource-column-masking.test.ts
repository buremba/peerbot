/**
 * Data-source column masking + admin-table gate.
 *
 * Regression: `executeDataSources` (the runtime path for view-template
 * `data_sources` and watcher source queries) called `buildScopedQuery` with NO
 * options, so the org-scoped CTEs fell back to `SELECT *` and exposed EVERY
 * physical column — including the ones the schema deliberately excludes
 * (connections.credentials, oauth_tokens.token_hash, …). It also never applied
 * the admin-only-table gate, so oauth_tokens/oauth_clients/user were freely
 * referenceable. A view-template data source surfaced via the PUBLIC_READ
 * `resolve_path` could therefore dump another tenant-surface's secret columns
 * to any member/anonymous reader.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeDataSources,
  validateDataSourceQuery,
} from '../../../utils/execute-data-sources';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

describe('data source column masking + admin-table gate', () => {
  let orgId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'DS Masking Org' });
    orgId = org.id;
  });

  async function seedConnectionWithSecret(secret: string) {
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credentials, created_at, updated_at
      ) VALUES (
        ${orgId}, 'test', 'masking-conn', 'Masking Conn', 'active',
        ${sql.json({ token: secret })}, NOW(), NOW()
      )
    `;
  }

  it('masks connections.credentials (excluded column) — the secret never reaches the rows', async () => {
    await seedConnectionWithSecret('SUPERSECRET-TOKEN');
    const sql = getTestDb();
    const results = await executeDataSources(
      { leak: { query: 'SELECT slug, credentials FROM connections' } },
      { organizationId: orgId },
      sql
    );
    // The masked CTE has no `credentials` column, so the outer SELECT errors and
    // the source yields no rows. Critically, the secret must not appear anywhere.
    expect(JSON.stringify(results)).not.toContain('SUPERSECRET-TOKEN');
    expect(results.leak).toEqual([]);
  });

  it('still returns allowlisted columns (masking does not break legitimate data sources)', async () => {
    await seedConnectionWithSecret('SUPERSECRET-TOKEN');
    const sql = getTestDb();
    const results = await executeDataSources(
      { ok: { query: 'SELECT slug FROM connections' } },
      { organizationId: orgId },
      sql
    );
    expect(results.ok.length).toBe(1);
    expect((results.ok[0] as { slug: string }).slug).toBe('masking-conn');
  });

  it('blocks admin-only auth/identity tables (oauth_tokens) at runtime', async () => {
    const sql = getTestDb();
    const results = await executeDataSources(
      { adm: { query: 'SELECT id FROM oauth_tokens' } },
      { organizationId: orgId },
      sql
    );
    expect(results.adm).toEqual([]);
  });

  it('rejects admin-only tables at save time (validateDataSourceQuery parse)', () => {
    expect(() =>
      validateDataSourceQuery('ds', 'SELECT token_hash FROM oauth_tokens', true)
    ).toThrow(/admin-only table/);
    expect(() =>
      validateDataSourceQuery('ds', 'SELECT email FROM "user"', true)
    ).toThrow(/admin-only table/);
  });
});
