/**
 * Manage Watchers Integration Tests
 *
 * Tests for watcher CRUD, versioning, and archive operations
 * through the manage_watchers tool.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Manage Watchers', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let token: string;
  let watcherId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Watcher Test Org' });
    user = await createTestUser({ email: 'watcher-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    entity = await createTestEntity({
      organization_id: org.id,
      name: 'Test Entity',
      entity_type: 'brand',
    });

    await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.notifications',
      entity_ids: [entity.id],
      created_by: user.id,
    });

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;
  });

  describe('create', () => {
    it('should create a watcher with prompt and schema', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'create',
          slug: 'test-sentiment',
          name: 'Sentiment Analysis',
          scheduler_client_id: 'codex',
          prompt: 'Analyze sentiment for {{entities}}',
          extraction_schema: {
            type: 'object',
            properties: { sentiment: { type: 'string' } },
          },
          entity_id: entity.id,
        },
        { token }
      );
      expect(result.watcher_id).toBeDefined();
      watcherId = result.watcher_id;
      expect(result.version).toBe(1);
    });

    it('should reject duplicate slug', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'create',
            slug: 'test-sentiment',
            name: 'Duplicate',
            prompt: 'test',
            extraction_schema: { type: 'object' },
            entity_id: entity.id,
          },
          { token }
        )
      ).rejects.toThrow();
    });

    it('should reject missing required fields', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'create',
            slug: 'incomplete',
          },
          { token }
        )
      ).rejects.toThrow();
    });
  });

  describe('create_version', () => {
    it('should create a new version', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'create_version',
          watcher_id: watcherId,
          name: 'Sentiment Analysis v2',
          prompt: 'Updated prompt for {{entities}}',
          extraction_schema: {
            type: 'object',
            properties: {
              sentiment: { type: 'string' },
              score: { type: 'number' },
            },
          },
          change_notes: 'Added score field',
        },
        { token }
      );
      expect(result.version).toBeDefined();
      expect(result.version).toBe(2);
    });

    it('should atomically update watcher-level schedule and connection when setting current version', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'create_version',
          watcher_id: watcherId,
          name: 'Sentiment Analysis v3',
          prompt: 'Updated prompt for {{entities}} with alerts',
          extraction_schema: {
            type: 'object',
            properties: {
              sentiment: { type: 'string' },
              score: { type: 'number' },
              needs_follow_up: { type: 'boolean' },
            },
          },
          schedule: '0 9 * * *',
          change_notes: 'Add daily schedule',
        },
        { token }
      );

      expect(result.version).toBe(3);

      const listed = await mcpToolsCall(
        'list_watchers',
        { entity_id: entity.id, include_details: true },
        { token }
      );
      const watcher = listed.watchers.find(
        (item: any) => String(item.watcher_id) === String(watcherId)
      );

      expect(watcher?.version).toBe(3);
      expect(watcher?.schedule).toBe('0 9 * * *');
      expect(watcher?.scheduler_client_id).toBe('codex');
      expect(watcher?.name).toBe('Sentiment Analysis v3');
    });

    it('should reject invalid schedules during create_version', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'create_version',
            watcher_id: watcherId,
            schedule: 'not-a-cron',
          },
          { token }
        )
      ).rejects.toThrow('Invalid cron expression');
    });
  });

  describe('list', () => {
    it('should list watchers for entity', async () => {
      const result = await mcpToolsCall('list_watchers', { entity_id: entity.id }, { token });
      expect(result.watchers).toBeDefined();
      expect(result.watchers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('get_versions', () => {
    it('should return version history', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        { action: 'get_versions', watcher_id: watcherId },
        { token }
      );
      expect(result.versions).toBeDefined();
      expect(result.versions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('get_version_details', () => {
    it('should return specific version details', async () => {
      const versions = await mcpToolsCall(
        'manage_watchers',
        { action: 'get_versions', watcher_id: watcherId },
        { token }
      );
      const v1 = versions.versions.find((v: any) => v.version === 1);

      const result = await mcpToolsCall(
        'manage_watchers',
        { action: 'get_version_details', watcher_id: watcherId, version: v1.version },
        { token }
      );
      expect(result.version ?? result.name).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete a watcher', async () => {
      // Create a disposable watcher
      const temp = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'create',
          slug: 'to-delete',
          name: 'Delete Me',
          prompt: 'test',
          extraction_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
          },
          entity_id: entity.id,
        },
        { token }
      );

      const result = await mcpToolsCall(
        'manage_watchers',
        { action: 'delete', watcher_ids: [temp.watcher_id] },
        { token }
      );
      expect(result.summary.successful).toBe(1);
    });

    it('should reject deleting nonexistent watcher', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        { action: 'delete', watcher_ids: ['999999'] },
        { token }
      );

      expect(result.summary.successful).toBe(0);
      expect(result.summary.failed).toBe(1);
      expect(result.results[0]?.message).toContain('Watcher not found');
    });
  });
});
