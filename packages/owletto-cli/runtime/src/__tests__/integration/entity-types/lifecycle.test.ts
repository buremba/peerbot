/**
 * Entity Type Lifecycle Tests
 *
 * Tests for entity type CRUD operations, soft-delete, org scoping,
 * system type protection, and entity creation type validation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Entity Type Lifecycle', () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let userA: Awaited<ReturnType<typeof createTestUser>>;
  let userB: Awaited<ReturnType<typeof createTestUser>>;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    orgA = await createTestOrganization({ name: 'Type Test Org A' });
    orgB = await createTestOrganization({ name: 'Type Test Org B' });

    userA = await createTestUser({ email: 'type-user-a@test.com' });
    userB = await createTestUser({ email: 'type-user-b@test.com' });

    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    const client = await createTestOAuthClient();
    const tokenAResult = await createTestAccessToken(userA.id, orgA.id, client.client_id);
    const tokenBResult = await createTestAccessToken(userB.id, orgB.id, client.client_id);
    tokenA = tokenAResult.token;
    tokenB = tokenBResult.token;
  });

  describe('List & Get (read operations)', () => {
    it('should list system entity types', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'list' },
        { token: tokenA }
      );

      expect(result.action).toBe('list');
      expect(result.entity_types).toBeDefined();
      expect(result.entity_types.length).toBeGreaterThan(0);

      // System types should have is_system = true
      const brand = result.entity_types.find((t: any) => t.slug === 'brand');
      expect(brand).toBeDefined();
      expect(brand.is_system).toBe(true);
    });

    it('should get a specific entity type by slug', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'get', slug: 'brand' },
        { token: tokenA }
      );

      expect(result.action).toBe('get');
      expect(result.entity_type).toBeDefined();
      expect(result.entity_type.slug).toBe('brand');
      expect(result.entity_type.is_system).toBe(true);
    });

    it('should return null for non-existent type', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'get', slug: 'nonexistent-type-xyz' },
        { token: tokenA }
      );

      expect(result.action).toBe('get');
      expect(result.entity_type).toBeNull();
    });
  });

  describe('Create', () => {
    it('should create a custom entity type', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'entity_type',
          action: 'create',
          slug: 'test-widget',
          name: 'Test Widget',
          description: 'A test entity type',
          icon: '🧪',
          color: '#ff0000',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('create');
      expect(result.entity_type).toBeDefined();
      expect(result.entity_type.slug).toBe('test-widget');
      expect(result.entity_type.name).toBe('Test Widget');
      expect(result.entity_type.is_system).toBe(false);
      expect(result.entity_type.entity_count).toBe(0);
    });

    it('should reject creating a type with a reserved slug', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          { schema_type: 'entity_type', action: 'create', slug: 'organization', name: 'Org Type' },
          { token: tokenA }
        )
      ).rejects.toThrow(/reserved/i);
    });

    it('should reject creating a duplicate slug', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          {
            schema_type: 'entity_type',
            action: 'create',
            slug: 'test-widget',
            name: 'Duplicate Widget',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/already exists/i);
    });

    it('should allow same slug in different orgs', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'entity_type',
          action: 'create',
          slug: 'test-widget',
          name: 'Test Widget Org B',
        },
        { token: tokenB }
      );

      expect(result.action).toBe('create');
      expect(result.entity_type.slug).toBe('test-widget');
    });

    it('should create type with metadata schema', async () => {
      const metadataSchema = {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          assignee: { type: 'string' },
        },
      };

      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'entity_type',
          action: 'create',
          slug: 'task-type',
          name: 'Task',
          metadata_schema: metadataSchema,
        },
        { token: tokenA }
      );

      expect(result.entity_type.slug).toBe('task-type');
      expect(result.entity_type.metadata_schema).toBeDefined();
    });
  });

  describe('Update', () => {
    it('should update a custom entity type', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'entity_type',
          action: 'update',
          slug: 'test-widget',
          name: 'Updated Widget',
          description: 'Updated description',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('update');
      expect(result.entity_type.name).toBe('Updated Widget');
    });

    it('should reject updating a system entity type', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          { schema_type: 'entity_type', action: 'update', slug: 'brand', name: 'Hacked Brand' },
          { token: tokenA }
        )
      ).rejects.toThrow(/Cannot update system entity type/i);
    });

    it('should reject updating another org entity type', async () => {
      // User B trying to update Org A's type
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          { schema_type: 'entity_type', action: 'update', slug: 'task-type', name: 'Hacked Task' },
          { token: tokenB }
        )
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('Delete', () => {
    it('should soft-delete a custom entity type with no entities', async () => {
      // Create a throwaway type
      await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'create', slug: 'to-delete', name: 'To Delete' },
        { token: tokenA }
      );

      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'delete', slug: 'to-delete' },
        { token: tokenA }
      );

      expect(result.action).toBe('delete');
      expect(result.success).toBe(true);

      // Verify it no longer appears in list
      const list = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'list' },
        { token: tokenA }
      );
      const deleted = list.entity_types.find((t: any) => t.slug === 'to-delete');
      expect(deleted).toBeUndefined();
    });

    it('should reject deleting a system entity type', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          { schema_type: 'entity_type', action: 'delete', slug: 'brand' },
          { token: tokenA }
        )
      ).rejects.toThrow(/Cannot delete system entity type/i);
    });

    it('should reject deleting a type that has entities', async () => {
      // Create an entity of type 'test-widget'
      const entity = await createTestEntity({
        name: 'Widget Entity',
        entity_type: 'test-widget',
        organization_id: orgA.id,
      });

      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          { schema_type: 'entity_type', action: 'delete', slug: 'test-widget' },
          { token: tokenA }
        )
      ).rejects.toThrow(/entities of this type exist/i);

      // Cleanup
      const sql = getTestDb();
      await sql`DELETE FROM entities WHERE id = ${entity.id}`;
    });
  });

  describe('Entity Creation Type Validation', () => {
    it('should allow creating entities with a valid type', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          entity_type: 'brand',
          name: 'Valid Brand',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('create');
      expect(result.entity.entity_type).toBe('brand');

      // Cleanup
      const sql = getTestDb();
      await sql`DELETE FROM entities WHERE id = ${result.entity.id}`;
    });

    it('should reject creating entities with unknown type', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'create',
            entity_type: 'nonexistent-type-abc',
            name: 'Invalid Entity',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/Unknown entity type/i);
    });

    it('should allow creating entities with a custom type', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          entity_type: 'test-widget',
          name: 'Custom Type Entity',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('create');
      expect(result.entity.entity_type).toBe('test-widget');

      // Cleanup
      const sql = getTestDb();
      await sql`DELETE FROM entities WHERE id = ${result.entity.id}`;
    });
  });

  describe('Audit Trail', () => {
    it('should record audit entries for create/update/delete', async () => {
      const sql = getTestDb();

      // Create
      await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'create', slug: 'audit-test', name: 'Audit Test' },
        { token: tokenA }
      );

      // Update
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'entity_type',
          action: 'update',
          slug: 'audit-test',
          name: 'Audit Test Updated',
        },
        { token: tokenA }
      );

      // Delete
      await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'delete', slug: 'audit-test' },
        { token: tokenA }
      );

      // Check audit entries
      const audits = await sql.unsafe(
        `SELECT action, actor FROM entity_type_audit
         WHERE entity_type_id = (
           SELECT id FROM entity_types WHERE slug = $1 LIMIT 1
         )
         ORDER BY created_at ASC`,
        ['audit-test']
      );

      expect(audits.length).toBe(3);
      expect(audits[0].action).toBe('create');
      expect(audits[1].action).toBe('update');
      expect(audits[2].action).toBe('delete');
      expect(audits[0].actor).toBe(userA.id);
    });
  });
});
