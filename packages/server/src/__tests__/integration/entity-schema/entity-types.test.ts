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
