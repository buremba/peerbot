/**
 * Entity Relationships Integration Tests
 *
 * Tests for relationship types CRUD, relationships CRUD, validation rules,
 * symmetric canonicalization, scope enforcement, and entity deletion cascade.
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
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Entity Relationships', () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let userA: Awaited<ReturnType<typeof createTestUser>>;
  let userB: Awaited<ReturnType<typeof createTestUser>>;
  let tokenA: string;

  // Entities for testing
  let entityA1: Awaited<ReturnType<typeof createTestEntity>>;
  let entityA2: Awaited<ReturnType<typeof createTestEntity>>;
  let entityB1: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();

    orgA = await createTestOrganization({ name: 'Rel Test Org A' });
    orgB = await createTestOrganization({ name: 'Rel Test Org B' });

    userA = await createTestUser({ email: 'rel-user-a@test.com' });
    userB = await createTestUser({ email: 'rel-user-b@test.com' });

    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    const client = await createTestOAuthClient();
    const tokenAResult = await createTestAccessToken(userA.id, orgA.id, client.client_id);
    await createTestAccessToken(userB.id, orgB.id, client.client_id);
    tokenA = tokenAResult.token;

    // Create test entities
    entityA1 = await createTestEntity({
      name: 'Entity A1',
      entity_type: 'brand',
      organization_id: orgA.id,
    });
    entityA2 = await createTestEntity({
      name: 'Entity A2',
      entity_type: 'brand',
      organization_id: orgA.id,
    });
    entityB1 = await createTestEntity({
      name: 'Entity B1',
      entity_type: 'brand',
      organization_id: orgB.id,
    });
  });

  // ============================================
  // Relationship Types CRUD
  // ============================================

  describe('Relationship Types', () => {
    it('should create a relationship type', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'integrates-with',
          name: 'Integrates With',
          description: 'One entity integrates with another',
          is_symmetric: true,
        },
        { token: tokenA }
      );

      expect(result.action).toBe('create');
      expect(result.relationship_type).toBeDefined();
      expect(result.relationship_type.slug).toBe('integrates-with');
      expect(result.relationship_type.name).toBe('Integrates With');
      expect(result.relationship_type.is_symmetric).toBe(true);
      expect(result.relationship_type.status).toBe('active');
    });

    it('should create a directional relationship type with inverse', async () => {
      // Create "depends-on" first
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'depends-on',
          name: 'Depends On',
          is_symmetric: false,
        },
        { token: tokenA }
      );

      // Create "dependency-of" pointing to "depends-on" as inverse
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'dependency-of',
          name: 'Dependency Of',
          is_symmetric: false,
          inverse_type_slug: 'depends-on',
        },
        { token: tokenA }
      );

      expect(result.relationship_type.inverse_type_slug).toBe('depends-on');
    });

    it('should reject creating a duplicate slug', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          {
            schema_type: 'relationship_type',
            action: 'create',
            slug: 'integrates-with',
            name: 'Dup',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/already exists/i);
    });

    it('should list relationship types', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'list' },
        { token: tokenA }
      );

      expect(result.action).toBe('list');
      expect(result.relationship_types.length).toBeGreaterThanOrEqual(3);
      const found = result.relationship_types.find((t: any) => t.slug === 'integrates-with');
      expect(found).toBeDefined();
    });

    it('should get a relationship type by slug', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'get', slug: 'integrates-with' },
        { token: tokenA }
      );

      expect(result.action).toBe('get');
      expect(result.relationship_type).toBeDefined();
      expect(result.relationship_type.slug).toBe('integrates-with');
    });

    it('should update a relationship type', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'update',
          slug: 'integrates-with',
          name: 'Integrates With (Updated)',
          description: 'Updated description',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('update');
      expect(result.relationship_type.name).toBe('Integrates With (Updated)');
    });

    it('should soft-delete a relationship type', async () => {
      // Create a disposable type
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'to-delete-type',
          name: 'To Delete',
        },
        { token: tokenA }
      );

      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'delete', slug: 'to-delete-type' },
        { token: tokenA }
      );

      expect(result.success).toBe(true);

      // Should not appear in list
      const list = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'list' },
        { token: tokenA }
      );
      const deleted = list.relationship_types.find((t: any) => t.slug === 'to-delete-type');
      expect(deleted).toBeUndefined();
    });
  });

  // ============================================
  // Type-Pair Rules
  // ============================================

  describe('Type-Pair Rules', () => {
    it('should add a rule', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'add_rule',
          slug: 'depends-on',
          source_entity_type_slug: 'brand',
          target_entity_type_slug: 'brand',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('add_rule');
      expect(result.rule).toBeDefined();
      expect(result.rule.source_entity_type_slug).toBe('brand');
      expect(result.rule.target_entity_type_slug).toBe('brand');
    });

    it('should reject duplicate rule', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          {
            schema_type: 'relationship_type',
            action: 'add_rule',
            slug: 'depends-on',
            source_entity_type_slug: 'brand',
            target_entity_type_slug: 'brand',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/already exists/i);
    });

    it('should list rules', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'list_rules', slug: 'depends-on' },
        { token: tokenA }
      );

      expect(result.action).toBe('list_rules');
      expect(result.rules.length).toBeGreaterThanOrEqual(1);
    });

    it('should remove a rule', async () => {
      const list = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'list_rules', slug: 'depends-on' },
        { token: tokenA }
      );
      const ruleId = list.rules[0].id;

      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'remove_rule', rule_id: ruleId },
        { token: tokenA }
      );

      expect(result.success).toBe(true);
    });
  });

  // ============================================
  // Relationships CRUD
  // ============================================

  describe('Relationships CRUD', () => {
    it('should create a relationship', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA1.id,
          to_entity_id: entityA2.id,
          relationship_type_slug: 'depends-on',
          source: 'api',
          confidence: 0.9,
          metadata: { reason: 'integration test' },
        },
        { token: tokenA }
      );

      expect(result.action).toBe('link');
      expect(result.relationship).toBeDefined();
      expect(result.relationship.from_entity_id).toBe(entityA1.id);
      expect(result.relationship.to_entity_id).toBe(entityA2.id);
      expect(result.relationship.confidence).toBe(0.9);
      expect(result.relationship.source).toBe('api');
    });

    it('should default confidence to 1.0 for api source', async () => {
      // Create another type for this test to avoid duplicate edge
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'alternative-to',
          name: 'Alternative To',
          is_symmetric: true,
        },
        { token: tokenA }
      );

      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA1.id,
          to_entity_id: entityA2.id,
          relationship_type_slug: 'alternative-to',
        },
        { token: tokenA }
      );

      expect(result.relationship.confidence).toBe(1.0);
      expect(result.relationship.source).toBe('api');
    });

    it('should update metadata, confidence, source only', async () => {
      // Get the first relationship
      const list = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: entityA1.id },
        { token: tokenA }
      );
      const relId = list.relationships[0].id;

      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'update_link',
          relationship_id: relId,
          metadata: { updated: true },
          confidence: 0.5,
          source: 'llm',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('update_link');
      expect(result.relationship.confidence).toBe(0.5);
      expect(result.relationship.source).toBe('llm');
    });

    it('should list relationships for an entity', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: entityA1.id },
        { token: tokenA }
      );

      expect(result.action).toBe('list_links');
      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
      expect(result.counts_by_type).toBeDefined();
      expect(result.metadata.total).toBeGreaterThanOrEqual(1);
    });

    it('should filter by direction (outbound)', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: entityA1.id, direction: 'outbound' },
        { token: tokenA }
      );

      for (const rel of result.relationships) {
        expect(rel.from_entity_id).toBe(entityA1.id);
      }
    });

    it('should filter by direction (inbound)', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: entityA2.id, direction: 'inbound' },
        { token: tokenA }
      );

      for (const rel of result.relationships) {
        expect(rel.to_entity_id).toBe(entityA2.id);
      }
    });

    it('should filter by relationship_type_slug', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'list_links',
          entity_id: entityA1.id,
          relationship_type_slug: 'depends-on',
        },
        { token: tokenA }
      );

      for (const rel of result.relationships) {
        expect(rel.relationship_type_slug).toBe('depends-on');
      }
    });

    it('should filter by confidence_min', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'list_links',
          entity_id: entityA1.id,
          confidence_min: 0.8,
        },
        { token: tokenA }
      );

      for (const rel of result.relationships) {
        expect(rel.confidence).toBeGreaterThanOrEqual(0.8);
      }
    });

    it('should soft-delete a relationship', async () => {
      // Create a disposable relationship
      await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'relationship_type', action: 'create', slug: 'temp-rel-type', name: 'Temp' },
        { token: tokenA }
      );
      const created = await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA1.id,
          to_entity_id: entityA2.id,
          relationship_type_slug: 'temp-rel-type',
        },
        { token: tokenA }
      );

      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'unlink', relationship_id: created.relationship.id },
        { token: tokenA }
      );

      expect(result.success).toBe(true);

      // Should not appear in default list
      const list = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: entityA1.id, relationship_type_slug: 'temp-rel-type' },
        { token: tokenA }
      );
      expect(list.relationships.length).toBe(0);
    });

    it('should include deleted with include_deleted flag', async () => {
      const list = await mcpToolsCall(
        'manage_entity',
        {
          action: 'list_links',
          entity_id: entityA1.id,
          relationship_type_slug: 'temp-rel-type',
          include_deleted: true,
        },
        { token: tokenA }
      );
      expect(list.relationships.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================
  // Validation Rules
  // ============================================

  describe('Validation', () => {
    it('should reject self-referencing relationship', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA1.id,
            relationship_type_slug: 'depends-on',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/self-referencing/i);
    });

    it('should reject invalid confidence (> 1)', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA2.id,
            relationship_type_slug: 'depends-on',
            confidence: 1.5,
          },
          { token: tokenA }
        )
      ).rejects.toThrow(); // TypeBox validates minimum/maximum at schema level
    });

    it('should reject invalid confidence (< 0)', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA2.id,
            relationship_type_slug: 'depends-on',
            confidence: -0.1,
          },
          { token: tokenA }
        )
      ).rejects.toThrow(); // TypeBox validates minimum/maximum at schema level
    });

    it('should reject invalid source', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA2.id,
            relationship_type_slug: 'depends-on',
            source: 'invalid-source' as any,
          },
          { token: tokenA }
        )
      ).rejects.toThrow(); // TypeBox validates union type at schema level
    });

    it('should reject duplicate active edge', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA2.id,
            relationship_type_slug: 'depends-on',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/already exists/i);
    });

    it('should reject cross-org relationship in multi-tenant mode', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityB1.id,
            relationship_type_slug: 'depends-on',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/organization/i);
    });

    it('should reject nonexistent relationship type', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'link',
            from_entity_id: entityA1.id,
            to_entity_id: entityA2.id,
            relationship_type_slug: 'nonexistent-type',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/not found/i);
    });
  });

  // ============================================
  // Symmetric Canonicalization
  // ============================================

  describe('Symmetric Canonicalization', () => {
    it('should canonicalize symmetric edges (A→B stored as min→max)', async () => {
      // "integrates-with" is symmetric, created above
      // Ensure no existing edge for this pair + type
      const sql = getTestDb();
      await sql`
        DELETE FROM entity_relationships
        WHERE relationship_type_id IN (
          SELECT id FROM entity_relationship_types WHERE slug = 'integrates-with'
        )
      `;

      // Create with A2→A1 (higher→lower), should be stored as A1→A2
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA2.id,
          to_entity_id: entityA1.id,
          relationship_type_slug: 'integrates-with',
        },
        { token: tokenA }
      );

      const minId = Math.min(entityA1.id, entityA2.id);
      const maxId = Math.max(entityA1.id, entityA2.id);
      expect(result.relationship.from_entity_id).toBe(minId);
      expect(result.relationship.to_entity_id).toBe(maxId);
    });

    it('should find symmetric edge from either side', async () => {
      // Query from A1's side
      const fromA1 = await mcpToolsCall(
        'manage_entity',
        {
          action: 'list_links',
          entity_id: entityA1.id,
          relationship_type_slug: 'integrates-with',
        },
        { token: tokenA }
      );
      expect(fromA1.relationships.length).toBeGreaterThanOrEqual(1);

      // Query from A2's side
      const fromA2 = await mcpToolsCall(
        'manage_entity',
        {
          action: 'list_links',
          entity_id: entityA2.id,
          relationship_type_slug: 'integrates-with',
        },
        { token: tokenA }
      );
      expect(fromA2.relationships.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================
  // Type-Pair Rule Enforcement
  // ============================================

  describe('Type-Pair Rule Enforcement', () => {
    beforeAll(async () => {
      // Create a type with a rule: only allows brand → brand
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'create',
          slug: 'brand-only-rel',
          name: 'Brand Only',
        },
        { token: tokenA }
      );
      await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'add_rule',
          slug: 'brand-only-rel',
          source_entity_type_slug: 'brand',
          target_entity_type_slug: 'brand',
        },
        { token: tokenA }
      );
    });

    it('should allow matching type pair', async () => {
      // Both entities are brands
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA1.id,
          to_entity_id: entityA2.id,
          relationship_type_slug: 'brand-only-rel',
        },
        { token: tokenA }
      );
      expect(result.action).toBe('link');
    });
  });

  // ============================================
  // Entity Deletion Cascade
  // ============================================

  describe('Entity Deletion Cascade', () => {
    it('should cascade delete relationships when entity is deleted', async () => {
      // Create a temporary entity and relationship
      const tempEntity = await createTestEntity({
        name: 'Temp Cascade Entity',
        entity_type: 'brand',
        organization_id: orgA.id,
      });

      await mcpToolsCall(
        'manage_entity',
        {
          action: 'link',
          from_entity_id: entityA1.id,
          to_entity_id: tempEntity.id,
          relationship_type_slug: 'depends-on',
        },
        { token: tokenA }
      );

      // Verify relationship exists
      const beforeDelete = await mcpToolsCall(
        'manage_entity',
        { action: 'list_links', entity_id: tempEntity.id },
        { token: tokenA }
      );
      expect(beforeDelete.relationships.length).toBeGreaterThanOrEqual(1);

      // Delete the entity via manage_entity (force to trigger hard delete + relationship cascade)
      await mcpToolsCall(
        'manage_entity',
        { action: 'delete', entity_id: tempEntity.id, force_delete_tree: true },
        { token: tokenA }
      );

      // Verify relationships are gone (even with include_deleted, hard-deleted)
      const sql = getTestDb();
      const remaining = await sql`
        SELECT id FROM entity_relationships
        WHERE from_entity_id = ${tempEntity.id} OR to_entity_id = ${tempEntity.id}
      `;
      expect(remaining.length).toBe(0);
    });
  });
});
