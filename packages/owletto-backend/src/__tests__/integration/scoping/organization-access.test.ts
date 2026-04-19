/**
 * Organization Scoping Tests
 *
 * Tests for multi-tenant data isolation:
 * - Users can read their own org's entities
 * - Users can read public org entities
 * - Users cannot read other private org entities
 * - Users can only write to their own org
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

describe('Organization Scoping', () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;

  let userA: Awaited<ReturnType<typeof createTestUser>>;
  let userB: Awaited<ReturnType<typeof createTestUser>>;

  let tokenA: string;
  let tokenB: string;

  let entityOrgA: Awaited<ReturnType<typeof createTestEntity>>;
  let entityOrgB: Awaited<ReturnType<typeof createTestEntity>>;
  let entityPublic: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    // Setup organizations
    orgA = await createTestOrganization({ name: 'Organization A' });
    orgB = await createTestOrganization({ name: 'Organization B' });
    publicOrg = await createTestOrganization({ name: 'Public Organization' });

    // Setup users
    userA = await createTestUser({ email: 'user-a@test.com', name: 'User A' });
    userB = await createTestUser({ email: 'user-b@test.com', name: 'User B' });

    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    // Create OAuth client and tokens
    const client = await createTestOAuthClient();
    const tokenAResult = await createTestAccessToken(userA.id, orgA.id, client.client_id);
    const tokenBResult = await createTestAccessToken(userB.id, orgB.id, client.client_id);
    tokenA = tokenAResult.token;
    tokenB = tokenBResult.token;

    // Create entities in each org
    entityOrgA = await createTestEntity({
      name: 'Entity in Org A',
      organization_id: orgA.id,
      domain: 'org-a.example.com',
    });
    entityOrgB = await createTestEntity({
      name: 'Entity in Org B',
      organization_id: orgB.id,
      domain: 'org-b.example.com',
    });
    entityPublic = await createTestEntity({
      name: 'Public Entity',
      organization_id: publicOrg.id,
      domain: 'public.example.com',
    });
  });

  describe('Read Access', () => {
    it('should allow user to read own org entities', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        { entity_id: entityOrgA.id },
        { token: tokenA }
      );

      expect(result.entity).toBeDefined();
      expect(result.entity.id).toBe(entityOrgA.id);
      expect(result.entity.name).toBe('Entity in Org A');
    });

    it('should deny user from reading other private org entities', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        { entity_id: entityOrgB.id },
        { token: tokenA }
      );

      // Entity should not be found (access denied = appears as not found)
      expect(result.entity).toBeNull();
      expect(result.discovery_status).toBe('not_found');
    });

    it('should allow any user to read public org entities', async () => {
      // User A reading public entity
      const resultA = await mcpToolsCall(
        'search_knowledge',
        { entity_id: entityPublic.id },
        { token: tokenA }
      );

      expect(resultA.entity).toBeDefined();
      expect(resultA.entity.id).toBe(entityPublic.id);

      // User B reading same public entity
      const resultB = await mcpToolsCall(
        'search_knowledge',
        { entity_id: entityPublic.id },
        { token: tokenB }
      );

      expect(resultB.entity).toBeDefined();
      expect(resultB.entity.id).toBe(entityPublic.id);
    });

    it('should filter search results by readable organizations', async () => {
      // User A searches - should only see own org + public entities
      const resultA = await mcpToolsCall(
        'search_knowledge',
        { query: 'Entity' },
        { token: tokenA }
      );

      // Should find Entity in Org A and Public Entity, but NOT Entity in Org B
      const entityNames = resultA.matches?.map((m: any) => m.name) || [];

      expect(entityNames).toContain('Entity in Org A');
      expect(entityNames).toContain('Public Entity');
      expect(entityNames).not.toContain('Entity in Org B');
    });
  });

  describe('Write Access', () => {
    it('should allow user to update own org entities', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'update',
          entity_id: entityOrgA.id,
          name: 'Updated Entity A',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('update');
      expect(result.entity.name).toBe('Updated Entity A');

      // Restore original name for other tests
      await mcpToolsCall(
        'manage_entity',
        {
          action: 'update',
          entity_id: entityOrgA.id,
          name: 'Entity in Org A',
        },
        { token: tokenA }
      );
    });

    it('should deny user from updating other org entities', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'update',
            entity_id: entityOrgB.id,
            name: 'Hacked Name',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/Access denied/);
    });

    it('should deny user from updating public org entities they do not own', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'update',
            entity_id: entityPublic.id,
            name: 'Hacked Public Entity',
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/Access denied/);
    });

    it('should deny user from deleting other org entities', async () => {
      // Secure behavior: entity is "not found" rather than "access denied"
      // This prevents information leakage about entity existence
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'delete',
            entity_id: entityOrgB.id,
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/not found|Access denied/i);
    });
  });

  describe('Create Access', () => {
    it('should create entities in user own org', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          entity_type: 'brand',
          name: 'New Brand by User A',
          domain: 'newbrand-a.example.com',
        },
        { token: tokenA }
      );

      expect(result.action).toBe('create');
      expect(result.entity.id).toBeDefined();

      // Verify entity is in correct org
      const sql = getTestDb();
      const [entity] = await sql`
        SELECT organization_id FROM entities WHERE id = ${result.entity.id}
      `;
      expect(entity.organization_id).toBe(orgA.id);

      // Cleanup: delete the test entity
      await sql`DELETE FROM entities WHERE id = ${result.entity.id}`;
    });

    it('should not allow creating entities in other orgs', async () => {
      // The create action doesn't accept organization_id -
      // it always uses the authenticated user's org
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          entity_type: 'brand',
          name: 'Brand Created by A',
        },
        { token: tokenA }
      );

      // Verify it was created in User A's org, not anywhere else
      const sql = getTestDb();
      const [entity] = await sql`
        SELECT organization_id FROM entities WHERE id = ${result.entity.id}
      `;
      expect(entity.organization_id).toBe(orgA.id);

      // Cleanup
      await sql`DELETE FROM entities WHERE id = ${result.entity.id}`;
    });
  });

  describe('Cross-Tenant Isolation', () => {
    it('should isolate connection operations to own org entities', async () => {
      // User A trying to list connections filtered by Org B's entity
      // Should return empty (connections are scoped to user's own org)
      const result = await mcpToolsCall(
        'manage_connections',
        {
          action: 'list',
          entity_id: entityOrgB.id,
        },
        { token: tokenA }
      );

      expect(result.connections).toBeDefined();
      expect(result.connections.length).toBe(0);
    });

    it('should isolate watchers operations to own org entities', async () => {
      // User A trying to create watcher for Org B's entity
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'list',
            entity_id: entityOrgB.id,
          },
          { token: tokenA }
        )
      ).rejects.toThrow(/Access denied/);
    });
  });
});
