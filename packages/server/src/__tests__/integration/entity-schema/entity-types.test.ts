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

    it('rejects a duplicate slug create', async () => {
      await owner.entity_schema.createType({ slug: 'dup-asset', name: 'Dup' });
      await expect(
        owner.entity_schema.createType({ slug: 'dup-asset', name: 'Dup 2' })
      ).rejects.toThrow(/already exists|duplicate/i);
      await owner.entity_schema.deleteType('dup-asset');
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

    it('round-trips a derived backing (sql + grain) and reverts to stored', async () => {
      // postgres.js may return text[] as a JS array or the raw "{a,b}" literal.
      const toArr = (v: unknown): string[] =>
        Array.isArray(v)
          ? (v as string[])
          : typeof v === 'string'
            ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean)
            : [];
      type Got = {
        entity_type?: {
          backing_sql?: string | null;
          backing_grain?: string[] | string | null;
          backing_source?: string | null;
          metadata_schema?: { properties?: Record<string, Record<string, unknown>> } | null;
        };
      };

      // create as a derived view (with aggregates → measures get inferred)
      await owner.entity_schema.createType({
        slug: 'spend-by-vendor',
        name: 'Spend by vendor',
        backing: {
          sql: 'SELECT company_id, currency, SUM(amount) AS total_spend, COUNT(DISTINCT u) AS users FROM events GROUP BY company_id, currency',
          grain: ['organization_id', 'connection_id', 'origin_id'],
        },
      });
      const created = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(created.entity_type?.backing_sql).toContain('SUM(amount)');
      expect(toArr(created.entity_type?.backing_grain)).toEqual([
        'organization_id',
        'connection_id',
        'origin_id',
      ]);
      // step-2 inference: aggregate columns become measures with a re-agg rule,
      // grouping columns become dimensions.
      const props = created.entity_type?.metadata_schema?.properties ?? {};
      expect((props.total_spend?.['x-measure'] as { reagg?: string })?.reagg).toBe('additive');
      expect((props.users?.['x-measure'] as { reagg?: string })?.reagg).toBe('holistic');
      expect(props.company_id?.['x-dimension']).toBeDefined();

      // update the view sql
      await owner.entity_schema.updateType({
        slug: 'spend-by-vendor',
        backing: { sql: 'SELECT company_id, AVG(amount) AS avg_spend FROM events GROUP BY company_id' },
      });
      const updated = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(updated.entity_type?.backing_sql).toContain('AVG(amount)');
      // re-inferred on the new sql: AVG → ratio
      expect(
        (updated.entity_type?.metadata_schema?.properties?.avg_spend?.['x-measure'] as {
          reagg?: string;
        })?.reagg
      ).toBe('ratio');
      // grain was not re-sent ⇒ cleared (backing is set as a unit)
      expect(toArr(updated.entity_type?.backing_grain)).toEqual([]);

      // revert to stored: backing = null clears the view AND the derived-only
      // measure annotations (they're meaningless on a stored type).
      await owner.entity_schema.updateType({ slug: 'spend-by-vendor', backing: null });
      const reverted = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(reverted.entity_type?.backing_sql ?? null).toBeNull();
      const revProps = reverted.entity_type?.metadata_schema?.properties ?? {};
      expect(revProps.avg_spend?.['x-measure']).toBeUndefined();

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

    it('rejects a duplicate relationship slug', async () => {
      await owner.entity_schema.createRelType({ slug: 'dup-rel', name: 'Dup' });
      await expect(
        owner.entity_schema.createRelType({ slug: 'dup-rel', name: 'Dup 2' })
      ).rejects.toThrow(/already exists|duplicate/i);
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
