/**
 * Get Content Advanced Integration Tests
 *
 * Tests for engagement scoring, watcher mode, advanced date filters,
 * kind/platform filters, and sort variations.
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
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Get Content Advanced', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let connection: Awaited<ReturnType<typeof createTestConnection>>;
  let template: Awaited<ReturnType<typeof createTestWatcherTemplate>>;
  let watcher: Awaited<ReturnType<typeof createTestWatcher>>;
  let cursorNewest: Awaited<ReturnType<typeof createTestEvent>>;
  let cursorTieLower: Awaited<ReturnType<typeof createTestEvent>>;
  let cursorTieHigher: Awaited<ReturnType<typeof createTestEvent>>;
  let cursorOlder: Awaited<ReturnType<typeof createTestEvent>>;
  let cursorOldest: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Content Adv Test Org' });
    user = await createTestUser({ email: 'content-adv@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({ name: 'Content Adv Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'test-content-connector',
      name: 'Content Connector',
      organization_id: org.id,
    });

    connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-content-connector',
      entity_ids: [entity.id],
    });

    // Create events with varying dates and scores
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Events with different dates
    await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Recent content with high engagement.',
      title: 'Recent Post',
      occurred_at: now,
      semantic_type: 'review',
    });

    await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Week-old content with medium engagement.',
      title: 'Week Old Post',
      occurred_at: oneWeekAgo,
      semantic_type: 'review',
    });

    await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Two weeks old discussion content.',
      title: 'Discussion Post',
      occurred_at: twoWeeksAgo,
      semantic_type: 'discussion',
    });

    await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Old content from a month ago.',
      title: 'Month Old Post',
      occurred_at: oneMonthAgo,
      semantic_type: 'content',
    });

    const cursorTieTimestamp = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    cursorNewest = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Newest cursor event.',
      title: 'Cursor Newest',
      occurred_at: new Date(now.getTime() - 60 * 1000),
      semantic_type: 'cursor-test',
    });

    cursorTieLower = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Tie cursor event lower id.',
      title: 'Cursor Tie Lower',
      occurred_at: cursorTieTimestamp,
      semantic_type: 'cursor-test',
    });

    cursorTieHigher = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Tie cursor event higher id.',
      title: 'Cursor Tie Higher',
      occurred_at: cursorTieTimestamp,
      semantic_type: 'cursor-test',
    });

    cursorOlder = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Older cursor event.',
      title: 'Cursor Older',
      occurred_at: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      semantic_type: 'cursor-test',
    });

    cursorOldest = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Oldest cursor event.',
      title: 'Cursor Oldest',
      occurred_at: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      semantic_type: 'cursor-test',
    });

    // Create watcher template + watcher for watcher mode test
    template = await createTestWatcherTemplate({
      slug: 'content-test-template',
      name: 'Content Test Template',
      prompt: 'Analyze content for {{entities}}',
      output_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    });

    watcher = await createTestWatcher({
      entity_id: entity.id,
      template_id: template.id,
      organization_id: org.id,
      schedule: '0 9 * * *',
      scheduler_client_id: 'codex',
    });
  });

  describe('sort variations', () => {
    it('should sort by date descending (default)', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, sort_by: 'date', sort_order: 'desc' },
        { token }
      );
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThanOrEqual(2);
      // First item should be the most recent
      const dates = result.content.map((c: any) => new Date(c.occurred_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('should sort by date ascending', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, sort_by: 'date', sort_order: 'asc' },
        { token }
      );
      expect(result.content).toBeDefined();
      const dates = result.content.map((c: any) => new Date(c.occurred_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeLessThanOrEqual(dates[i]);
      }
    });

    it('should sort by score', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, sort_by: 'score' },
        { token }
      );
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('date filters', () => {
    it('should filter with since date', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, since: '7d' },
        { token }
      );
      expect(result.content).toBeDefined();
      // Should only include recent content
      for (const item of result.content) {
        const occurredAt = new Date(item.occurred_at);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        expect(occurredAt.getTime()).toBeGreaterThanOrEqual(sevenDaysAgo.getTime() - 60000);
      }
    });

    it('should filter with since + until combined', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, since: '30d', until: '7d' },
        { token }
      );
      expect(result.content).toBeDefined();
    });
  });

  describe('chronological cursor pagination', () => {
    it('normalizes root_origin_id for top-level results', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, semantic_type: 'cursor-test', sort_by: 'date', sort_order: 'desc' },
        { token }
      );

      expect(result.content.length).toBeGreaterThanOrEqual(5);
      for (const item of result.content) {
        expect(item.origin_parent_id).toBeNull();
        expect(item.root_origin_id).toBe(item.origin_id);
      }
    });

    it('returns older and newer chronological slices without overlap', async () => {
      const firstSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
        },
        { token }
      );

      expect(firstSlice.page.has_older).toBe(true);
      expect(firstSlice.page.has_newer).toBe(false);
      expect(firstSlice.content.map((item: any) => item.id)).toEqual([
        cursorNewest.id,
        cursorTieHigher.id,
      ]);

      const olderSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
          before_occurred_at: firstSlice.content[1].occurred_at,
          before_id: firstSlice.content[1].id,
        },
        { token }
      );

      expect(olderSlice.page.has_newer).toBe(true);
      expect(olderSlice.page.has_older).toBe(true);
      expect(olderSlice.content.map((item: any) => item.id)).toEqual([
        cursorTieLower.id,
        cursorOlder.id,
      ]);

      const oldestSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
          before_occurred_at: olderSlice.content[1].occurred_at,
          before_id: olderSlice.content[1].id,
        },
        { token }
      );

      expect(oldestSlice.content.map((item: any) => item.id)).toEqual([cursorOldest.id]);
      expect(oldestSlice.page.has_older).toBe(false);
      expect(oldestSlice.page.has_newer).toBe(true);

      const newerSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
          after_occurred_at: olderSlice.content[0].occurred_at,
          after_id: olderSlice.content[0].id,
        },
        { token }
      );

      expect(newerSlice.content.map((item: any) => item.id)).toEqual([
        cursorNewest.id,
        cursorTieHigher.id,
      ]);
    });

    it('uses id as the tie-breaker when timestamps are identical', async () => {
      const firstSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
        },
        { token }
      );

      const nextSlice = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'date',
          sort_order: 'desc',
          limit: 1,
          before_occurred_at: firstSlice.content[1].occurred_at,
          before_id: firstSlice.content[1].id,
        },
        { token }
      );

      expect(firstSlice.content[1].id).toBe(cursorTieHigher.id);
      expect(nextSlice.content[0].id).toBe(cursorTieLower.id);
      expect(nextSlice.content[0].occurred_at).toBe(firstSlice.content[1].occurred_at);
    });

    it('ignores chronological cursors when sort_by=score', async () => {
      const baseline = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'score',
          limit: 3,
        },
        { token }
      );

      const withCursor = await mcpToolsCall(
        'read_knowledge',
        {
          entity_id: entity.id,
          semantic_type: 'cursor-test',
          sort_by: 'score',
          limit: 3,
          before_occurred_at: new Date().toISOString(),
          before_id: cursorOlder.id,
          after_occurred_at: new Date().toISOString(),
          after_id: cursorNewest.id,
        },
        { token }
      );

      expect(withCursor.content.map((item: any) => item.id)).toEqual(
        baseline.content.map((item: any) => item.id)
      );
    });
  });

  describe('semantic type filter', () => {
    it('should filter by semantic_type', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, semantic_type: 'review' },
        { token }
      );
      expect(result.content).toBeDefined();
      // semantic type filter works at the SQL level; verify only review items are returned
      expect(result.content.length).toBe(2);
      const titles = result.content.map((c: any) => c.title);
      expect(titles).toContain('Recent Post');
      expect(titles).toContain('Week Old Post');
    });
  });

  describe('watcher mode', () => {
    it('should return content for watcher_id with window token', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { watcher_id: watcher.id, since: '30d' },
        { token }
      );
      expect(result.content).toBeDefined();
      expect(result.window_token).toBeDefined();
      expect(result.window_start).toBeDefined();
      expect(result.window_end).toBeDefined();
    });

    it('should store execution provenance and advance next_run_at on complete_window', async () => {
      const before = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );

      const contentResult = await mcpToolsCall(
        'read_knowledge',
        { watcher_id: watcher.id, since: '30d' },
        { token }
      );

      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'complete_window',
          window_token: contentResult.window_token,
          extracted_data: { summary: 'External analysis summary' },
          model: 'gpt-5.4',
          run_metadata: { provider: 'openai', temperature: 0.2 },
        },
        { token }
      );

      const after = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );

      expect(after.windows.length).toBeGreaterThan(0);
      expect(after.windows[0]?.model_used).toBe('gpt-5.4');
      expect(after.windows[0]?.client_id).toBe(client.client_id);
      expect(after.windows[0]?.run_metadata).toEqual({ provider: 'openai', temperature: 0.2 });
      expect(after.watcher?.next_run_at).toBeDefined();
      expect(new Date(after.watcher.next_run_at).getTime()).toBeGreaterThan(
        new Date(before.watcher.next_run_at).getTime()
      );
    });
  });

  describe('pagination', () => {
    it('should respect limit and offset', async () => {
      const page1 = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, limit: 2, offset: 0 },
        { token }
      );
      expect(page1.content.length).toBeLessThanOrEqual(2);
      expect(page1.total).toBeGreaterThanOrEqual(2);

      const page2 = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, limit: 2, offset: 2 },
        { token }
      );
      expect(page2.content).toBeDefined();
      // Pages should have different content
      if (page1.content.length > 0 && page2.content.length > 0) {
        expect(page1.content[0].id).not.toBe(page2.content[0].id);
      }
    });
  });
});
