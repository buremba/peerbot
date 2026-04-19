/**
 * Resolve Path Integration Tests
 *
 * Tests for URL path resolution into workspace and entity hierarchy.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
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

describe('Resolve Path', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let parentEntity: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Path Test Org', slug: 'path-test' });
    user = await createTestUser({ email: 'path-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    parentEntity = await createTestEntity({
      name: 'Test Brand',
      entity_type: 'brand',
      organization_id: org.id,
      created_by: user.id,
    });

    await createTestEntity({
      name: 'Test Product',
      entity_type: 'product',
      organization_id: org.id,
      parent_id: parentEntity.id,
      created_by: user.id,
    });
  });

  describe('workspace resolution', () => {
    it('should resolve org slug to workspace', async () => {
      const result = await mcpToolsCall('resolve_path', { path: `/${org.slug}` }, { token });
      expect(result.workspace).toBeDefined();
      expect(result.workspace.slug).toBe(org.slug);
    });

    it('should return error for nonexistent workspace', async () => {
      await expect(
        mcpToolsCall('resolve_path', { path: '/nonexistent-org-xyz-12345' }, { token })
      ).rejects.toThrow();
    });
  });

  describe('entity type path', () => {
    it('should reject odd-segment entity paths', async () => {
      await expect(
        mcpToolsCall('resolve_path', { path: `/${org.slug}/brand` }, { token })
      ).rejects.toThrow();
    });

    it('should reject nonexistent entity type/slug pairs', async () => {
      await expect(
        mcpToolsCall(
          'resolve_path',
          { path: `/${org.slug}/nonexistent-type/nonexistent-slug` },
          { token }
        )
      ).rejects.toThrow();
    });
  });

  describe('entity path walking', () => {
    it('should resolve single entity type/slug pair', async () => {
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/test-brand` },
        { token }
      );
      expect(result.entity).toBeDefined();
      expect(result.entity.name).toBe('Test Brand');
    });

    it('should resolve nested entity path', async () => {
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/test-brand/product/test-product` },
        { token }
      );
      expect(result.entity).toBeDefined();
      expect(result.entity.name).toBe('Test Product');
    });

    it('should return error for not found entity', async () => {
      await expect(
        mcpToolsCall('resolve_path', { path: `/${org.slug}/brand/nonexistent-brand` }, { token })
      ).rejects.toThrow();
    });
  });

  describe('children & siblings', () => {
    it('should return children for parent entity', async () => {
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/test-brand` },
        { token }
      );
      expect(result.children).toBeDefined();
      expect(result.children.length).toBeGreaterThanOrEqual(1);
      expect(result.children[0].name).toBe('Test Product');
    });
  });

  describe('bootstrap data', () => {
    it('should return bootstrap when requested', async () => {
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}`, include_bootstrap: true },
        { token }
      );
      expect(result.bootstrap).toBeDefined();
      expect(result.bootstrap.entity_types).toBeDefined();
      expect(result.bootstrap.summary).toBeDefined();
    });

    it('should not return bootstrap by default', async () => {
      const result = await mcpToolsCall('resolve_path', { path: `/${org.slug}` }, { token });
      expect(result.bootstrap).toBeNull();
    });
  });
});
