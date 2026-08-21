import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestOrganization } from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';

function metadataFor(key: string, relationshipType: string): ConnectorMetadata {
  return {
    key,
    name: key,
    version: '1.0.0',
    authSchema: null,
    webhook: null,
    feeds: {
      invoices: {
        key: 'invoices',
        name: 'Invoices',
        eventKinds: {
          invoice: {
            attributions: [
              { name: 'invoice', role: 'belongs_to', target: { entityType: 'invoice' } },
              { name: 'customer', role: 'about', target: { entityType: 'customer' } },
            ],
            relationships: [
              { type: relationshipType, from: 'invoice', to: 'customer' },
            ],
          },
        },
      },
    },
    actions: null,
    automationEvents: null,
    optionsSchema: null,
  };
}

function versionRecord(key: string) {
  return {
    compiledCode: `// compiled ${key}`,
    compiledCodeHash: `hash-${key}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${key}`,
    sourcePath: `${key}.ts`,
  };
}

describe('connector relationship-type preflight', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgId = (await createTestOrganization({ name: 'Connector Relationship Preflight' })).id;
  });

  async function install(key: string, relationshipType: string) {
    return upsertConnectorDefinitionRecords({
      sql: getTestDb(),
      organizationId: orgId,
      metadata: metadataFor(key, relationshipType),
      versionRecord: versionRecord(key),
      versionScope: 'organization',
    });
  }

  async function createRelationshipType(
    slug: string,
    values: { status?: 'active' | 'archived'; deleted?: boolean; purpose?: string } = {}
  ) {
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_relationship_types (
        organization_id, slug, name, status, deleted_at, purpose
      ) VALUES (
        ${orgId}, ${slug}, ${slug}, ${values.status ?? 'active'},
        ${values.deleted ? new Date() : null}, ${values.purpose ?? null}
      )
    `;
  }

  it('accepts an active ordinary relationship type', async () => {
    await createRelationshipType('invoice_customer');
    await expect(install('ordinary-relationship', 'invoice_customer')).resolves.toMatchObject({
      updated: false,
    });
  });

  it('rejects a missing relationship type with connector/feed/event context', async () => {
    await expect(install('missing-relationship', 'missing_type')).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringMatching(
        /missing-relationship.*feed 'invoices'.*event kind 'invoice'.*missing_type/i
      ),
    });
  });

  it.each([
    ['archived', { status: 'archived' as const }],
    ['deleted', { deleted: true }],
  ])('rejects an %s relationship type', async (label, values) => {
    const slug = `${label}_relationship`;
    await createRelationshipType(slug, values);
    await expect(install(`${label}-connector`, slug)).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringMatching(new RegExp(`${label}-connector.*${slug}.*not active`, 'i')),
    });
  });

  it('resolves the active row past a newer same-slug tombstone', async () => {
    // The unique index is partial on status='active', so an archived row can
    // carry a HIGHER id than the live one — selecting by id alone would report
    // an active type as archived.
    await createRelationshipType('tombstoned_relationship');
    await createRelationshipType('tombstoned_relationship', {
      status: 'archived',
      deleted: true,
    });
    await expect(install('tombstone-connector', 'tombstoned_relationship')).resolves.toMatchObject(
      { updated: false }
    );
  });

  it('rejects a purpose-classified authorization relationship type', async () => {
    await createRelationshipType('authorization_edge', { purpose: 'authorization' });
    // Carries the ACL guard's 403 rather than a bare Error: a connector whose
    // vocabulary is refused is a caller-fixable install, not a server fault.
    await expect(install('authorization-connector', 'authorization_edge')).rejects.toMatchObject({
      httpStatus: 403,
      message: expect.stringMatching(/authorization_edge.*authorization-bearing/i),
    });
  });

  it('rejects the staged member_of compatibility slug before classification', async () => {
    await createRelationshipType('member_of');
    await expect(install('member-of-connector', 'member_of')).rejects.toThrow(
      /member_of.*authorization-bearing/i
    );
  });

  it('allows an ordinary slug even when its name resembles authorization vocabulary', async () => {
    await createRelationshipType('authorization_note');
    await expect(install('authorization-note-connector', 'authorization_note')).resolves.toMatchObject(
      { updated: false }
    );
  });
});
