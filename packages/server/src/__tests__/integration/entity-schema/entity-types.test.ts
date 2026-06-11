/**
 * Entity-type and relationship-type CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted `manage_entity_schema` integration tests. Each scenario
 * uses TestApiClient (direct handler) so we exercise real DB writes without
 * paying the HTTP/sandbox round-trip on every assertion. The MCP wire path is
 * covered separately in `mcp-auth-wire.test.ts` and `sandbox-execute.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('entity schema CRUD', () => {
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Schema Test Org' });
    const user = await createTestUser({ email: 'schema-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  describe('entity_type', () => {
    it('creates → reads back → updates → deletes', async () => {
      await owner.entity_schema.createType({
        slug: 'lifecycle-asset',
        name: 'Asset',
        description: 'A trackable asset',
      });

      const got = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type?: { name: string; description?: string };
      };
      expect(got.entity_type?.name).toBe('Asset');
      expect(got.entity_type?.description).toBe('A trackable asset');

      await owner.entity_schema.updateType({
        slug: 'lifecycle-asset',
        name: 'Asset (renamed)',
      });
      const after = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type?: { name: string };
      };
      expect(after.entity_type?.name).toBe('Asset (renamed)');

      await owner.entity_schema.deleteType('lifecycle-asset');
      const tombstone = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type: null | unknown;
      };
      expect(tombstone.entity_type).toBeNull();
    });

    it('rejects a duplicate slug create with a coded 409', async () => {
      await owner.entity_schema.createType({ slug: 'dup-asset', name: 'Dup' });
      // `lobu apply` upserts by probing create and retrying as update ONLY on
      // this explicit duplicate signal — the code + 409 are load-bearing.
      const err = await owner.entity_schema
        .createType({ slug: 'dup-asset', name: 'Dup 2' })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/\[entity_type_exists\].*already exists/);
      expect(err?.httpStatus).toBe(409);
      await owner.entity_schema.deleteType('dup-asset');
    });

    it('rejects >4 x-table-column fields with a 422 carrying the real message (issue #1177)', async () => {
      // Five flagged columns; before the fix this surfaced through `lobu apply`
      // as a misleading "Entity type 'task' not found" instead of the message.
      const properties = Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((f) => [
          f,
          { type: 'string', 'x-table-column': true },
        ])
      );
      const err = await owner.entity_schema
        .createType({
          slug: 'too-many-columns',
          name: 'Too Many',
          metadata_schema: { type: 'object', properties },
        })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toContain('[invalid_schema]');
      expect(err?.message).toContain('At most 4 metadata fields can have x-table-column=true.');
      expect(err?.httpStatus).toBe(422);
      // Validation rejected the create entirely — nothing persisted, so a
      // follow-up create-after-fix is a clean create (not an update).
      const got = (await owner.entity_schema.getType('too-many-columns')) as {
        entity_type: unknown;
      };
      expect(got.entity_type).toBeNull();
    });

    it('lists user-created types alongside system types', async () => {
      await owner.entity_schema.createType({ slug: 'lst-asset', name: 'Lst' });
      const list = (await owner.entity_schema.listTypes()) as {
        entity_types?: Array<{ slug: string }>;
      };
      const slugs = list.entity_types?.map((t) => t.slug) ?? [];
      expect(slugs).toContain('lst-asset');
      await owner.entity_schema.deleteType('lst-asset');
    });

    it('round-trips a derived backing (sql) and reverts to stored', async () => {
      type Got = {
        entity_type?: {
          backing_sql?: string | null;
          measure_columns?: string[];
          metadata_schema?: { properties?: Record<string, Record<string, unknown>> } | null;
        };
      };

      await owner.entity_schema.createType({
        slug: 'spend-by-vendor',
        name: 'Spend by vendor',
        backing: {
          sql: 'SELECT company_id, currency, SUM(amount) AS total_spend, COUNT(DISTINCT u) AS users FROM events GROUP BY company_id, currency',
        },
      });
      const created = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(created.entity_type?.backing_sql).toContain('SUM(amount)');
      // Measure columns are classified ON READ (not persisted into metadata_schema).
      expect((created.entity_type?.measure_columns ?? []).sort()).toEqual([
        'total_spend',
        'users',
      ]);
      // No inferred annotations are persisted — metadata_schema stays as authored.
      const props = created.entity_type?.metadata_schema?.properties ?? {};
      expect(props.total_spend).toBeUndefined();

      // update the view sql → backing_sql changes, measure_columns recompute
      await owner.entity_schema.updateType({
        slug: 'spend-by-vendor',
        backing: { sql: 'SELECT company_id, AVG(amount) AS avg_spend FROM events GROUP BY company_id' },
      });
      const updated = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(updated.entity_type?.backing_sql).toContain('AVG(amount)');
      expect(updated.entity_type?.measure_columns).toEqual(['avg_spend']);

      // revert to stored: backing = null clears the view; no measure_columns.
      await owner.entity_schema.updateType({ slug: 'spend-by-vendor', backing: null });
      const reverted = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(reverted.entity_type?.backing_sql ?? null).toBeNull();
      expect(reverted.entity_type?.measure_columns ?? []).toEqual([]);

      await owner.entity_schema.deleteType('spend-by-vendor');
    });

    it('a stored type carries no backing_sql', async () => {
      await owner.entity_schema.createType({ slug: 'plain-thing', name: 'Plain' });
      const got = (await owner.entity_schema.getType('plain-thing')) as {
        entity_type?: { backing_sql?: string | null };
      };
      expect(got.entity_type?.backing_sql ?? null).toBeNull();
      await owner.entity_schema.deleteType('plain-thing');
    });

    it('rejects an empty / whitespace backing.sql (no corrupt derived type)', async () => {
      // TypeBox minLength isn't enforced for this tool, so the handler guards.
      await expect(
        owner.entity_schema.createType({
          slug: 'blank-view',
          name: 'Blank',
          backing: { sql: '   ' },
        })
      ).rejects.toThrow(/backing\.sql cannot be empty/i);
    });
  });

  describe('relationship_type', () => {
    it('creates a symmetric type', async () => {
      const result = (await owner.entity_schema.createRelType({
        slug: 'collaborates-with',
        name: 'Collaborates With',
      })) as { relationship_type?: { slug: string; status: string } };
      expect(result.relationship_type?.slug).toBe('collaborates-with');
      expect(result.relationship_type?.status).toBe('active');
      await owner.entity_schema.deleteRelType('collaborates-with');
    });

    it('rejects a duplicate relationship slug with a coded 409', async () => {
      await owner.entity_schema.createRelType({ slug: 'dup-rel', name: 'Dup' });
      const err = await owner.entity_schema
        .createRelType({ slug: 'dup-rel', name: 'Dup 2' })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/\[relationship_type_exists\].*already exists/);
      expect(err?.httpStatus).toBe(409);
      await owner.entity_schema.deleteRelType('dup-rel');
    });
  });

  describe('access control', () => {
    it('blocks a member without admin scope from creating types', async () => {
      const member = owner.withAuth({ memberRole: 'member' });
      await expect(
        member.entity_schema.createType({ slug: 'blocked-type', name: 'Blocked' })
      ).rejects.toThrow(/admin|owner|access/i);
    });

    it('blocks an unauthenticated caller', async () => {
      const anon = owner.withAuth({ userId: null, memberRole: null });
      await expect(
        anon.entity_schema.createType({ slug: 'anon-type', name: 'Anon' })
      ).rejects.toThrow();
    });
  });
});
