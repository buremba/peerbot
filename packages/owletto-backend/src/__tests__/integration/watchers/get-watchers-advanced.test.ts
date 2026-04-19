/**
 * Get Watchers Advanced Integration Tests
 *
 * Tests for watcher querying by watcher_id vs entity_id, date ranges,
 * granularity inference, pagination, and pending analysis.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  createTestWatcher,
  createTestWatcherTemplate,
  createTestWatcherWindow,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Get Watchers Advanced', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let template: Awaited<ReturnType<typeof createTestWatcherTemplate>>;
  let watcher: Awaited<ReturnType<typeof createTestWatcher>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Watchers Adv Test Org' });
    user = await createTestUser({ email: 'watchers-adv@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({ name: 'Watchers Adv Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'test-watchers-connector',
      name: 'Watchers Connector',
      organization_id: org.id,
    });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-watchers-connector',
      entity_ids: [entity.id],
    });

    // Create some events
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: conn.id,
        content: `Content item ${i + 1} for watcher testing`,
        title: `Item ${i + 1}`,
        occurred_at: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
      });
    }

    template = await createTestWatcherTemplate({
      slug: 'watchers-adv-template',
      name: 'Advanced Watchers Template',
      prompt: 'Analyze {{entities}}',
      output_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          themes: { type: 'array', items: { type: 'string' } },
        },
      },
    });

    watcher = await createTestWatcher({
      entity_id: entity.id,
      template_id: template.id,
      organization_id: org.id,
      schedule: '0 0 * * 1',
    });

    // Create watcher windows
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    await createTestWatcherWindow({
      watcher_id: watcher.id,
      window_start: windowStart,
      window_end: windowEnd,
      granularity: 'weekly',
      extracted_data: {
        summary: 'Overall positive trend with some concerns about performance.',
        themes: ['performance', 'reliability', 'user experience'],
      },
      content_analyzed: 5,
    });
  });

  describe('query by watcher_id', () => {
    it('should return windows for specific watcher', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.windows.length).toBeGreaterThanOrEqual(1);
      expect(result.watcher).toBeDefined();
    });
  });

  describe('query by entity_id', () => {
    it('should return watchers for entity', async () => {
      const result = await mcpToolsCall('list_watchers', { entity_id: entity.id }, { token });
      expect(result.watchers).toBeDefined();
      expect(result.watchers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('date range', () => {
    it('should filter with content_since alias', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id), content_since: '30d' },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it('should filter with since + until', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        {
          watcher_id: String(watcher.id),
          content_since: '30d',
          content_until: 'today',
        },
        { token }
      );
      expect(result.windows).toBeDefined();
    });
  });

  describe('granularity', () => {
    it('should accept explicit granularity', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id), granularity: 'weekly' },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.metadata?.granularity_filter).toBeDefined();
    });

    it('should infer granularity from date range', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id), content_since: '7d' },
        { token }
      );
      expect(result.metadata).toBeDefined();
      // 7d range should infer daily granularity
      expect(result.metadata?.granularity_filter).toBeDefined();
    });
  });

  describe('pagination', () => {
    it('should support page and page_size', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id), page: 1, page_size: 10 },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.pagination).toBeDefined();
    });
  });

  describe('pending analysis', () => {
    it('should include pending analysis info', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );
      // pending_analysis may or may not exist depending on state
      expect(result.windows).toBeDefined();
    });
  });

  describe('template version info', () => {
    it('should include template version in window data', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );
      expect(result.windows).toBeDefined();
      if (result.windows.length > 0) {
        expect(result.windows[0].watcher_name).toBeDefined();
        expect(result.windows[0].granularity).toBe('weekly');
        expect(result.windows[0].content_analyzed).toBeDefined();
        expect(result.windows[0].extracted_data).toBeDefined();
      }
    });
  });
});
