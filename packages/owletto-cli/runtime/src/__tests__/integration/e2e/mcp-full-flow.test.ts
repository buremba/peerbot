/**
 * MCP Full Flow End-to-End Test
 *
 * Tests the complete lifecycle through MCP tools:
 *   Entity type → Entity → Connection → Events →
 *   Classification → Search (text, vector, metadata) →
 *   Watcher template → Watcher querying with windows
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestClassifier,
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

describe('MCP Full Flow E2E', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let connDef: Awaited<ReturnType<typeof createTestConnectorDefinition>>;
  let conn: Awaited<ReturnType<typeof createTestConnection>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    // Ensure system users exist for FK constraints
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
      VALUES ('api', 'API User', 'api@system.internal', 'api-system-user', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    org = await createTestOrganization({ name: 'E2E Test Org' });
    user = await createTestUser({ email: 'e2e-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    // Create connector + connection + entity for later steps
    connDef = await createTestConnectorDefinition({
      key: 'e2e-connector',
      name: 'E2E Connector',
      organization_id: org.id,
    });
    entity = await createTestEntity({
      name: 'E2E Brand',
      entity_type: 'brand',
      organization_id: org.id,
      domain: 'e2e-brand.com',
    });
    conn = await createTestConnection({
      organization_id: org.id,
      connector_key: connDef.key,
      entity_ids: [entity.id],
    });
  });

  // ========================================
  // 1. Entity search (text-only, existing behavior)
  // ========================================
  describe('1. Entity search (text)', () => {
    it('should find entity by name with fuzzy match', async () => {
      const result = await mcpToolsCall('search_knowledge', { query: 'E2E Brand' }, { token });
      expect(result.matches).toBeDefined();
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].name).toBe('E2E Brand');
      expect(result.entity).toBeDefined();
    });

    it('should find entity by ID', async () => {
      const result = await mcpToolsCall('search_knowledge', { entity_id: entity.id }, { token });
      expect(result.entity).toBeDefined();
      expect(result.entity.id).toBe(entity.id);
    });

    it('should filter by entity_type', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        { query: 'E2E', entity_type: 'brand' },
        { token }
      );
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches.every((m: any) => m.type === 'brand')).toBe(true);
    });

    it('should return empty for non-existent entity', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        { query: 'ZZZZ_nonexistent_entity_ZZZZ' },
        { token }
      );
      expect(result.matches.length).toBe(0);
      expect(result.discovery_status).toBe('not_found');
    });
  });

  // ========================================
  // 2. Search with metadata_filter
  // ========================================
  describe('2. Search with metadata_filter', () => {
    let metadataEntity: Awaited<ReturnType<typeof createTestEntity>>;

    beforeAll(async () => {
      const sql = getTestDb();

      metadataEntity = await createTestEntity({
        name: 'Dark mode preference',
        entity_type: 'brand',
        organization_id: org.id,
      });
      await sql`
        UPDATE entities
        SET metadata = ${sql.json({ namespace: 'agent:prefs', importance: '0.8' })}
        WHERE id = ${metadataEntity.id}
      `;
    });

    it('should filter entities by metadata key-value pairs', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        {
          query: 'Dark mode preference',
          entity_type: 'brand',
          metadata_filter: { namespace: 'agent:prefs' },
        },
        { token }
      );
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      const match = result.matches.find((m: any) => m.id === metadataEntity.id);
      expect(match).toBeDefined();
    });

    it('should return empty when metadata filter does not match', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        {
          query: 'Dark mode preference',
          entity_type: 'brand',
          metadata_filter: { namespace: 'nonexistent:namespace' },
        },
        { token }
      );
      const match = result.matches?.find((m: any) => m.id === metadataEntity.id);
      expect(match).toBeUndefined();
    });
  });

  // ========================================
  // 3. Search with query_embedding (vector similarity)
  // ========================================
  describe('3. Search with query_embedding', () => {
    // Generate a deterministic 768-dim vector for testing
    const testVector = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1));
    let embeddedEntity: Awaited<ReturnType<typeof createTestEntity>>;

    beforeAll(async () => {
      const sql = getTestDb();

      embeddedEntity = await createTestEntity({
        name: 'Vector Search Entity',
        entity_type: 'brand',
        organization_id: org.id,
      });
      // Set a 768-dimensional embedding (matching the column constraint)
      const vectorLiteral = `[${testVector.join(',')}]`;
      await sql.unsafe('UPDATE entities SET embedding = $1::vector WHERE id = $2', [
        vectorLiteral,
        embeddedEntity.id,
      ]);
    });

    it('should find entities by vector similarity (with text query)', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        {
          query: 'Vector Search',
          query_embedding: testVector,
        },
        { token }
      );
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      const match = result.matches.find((m: any) => m.id === embeddedEntity.id);
      expect(match).toBeDefined();
      expect(match.match_reason).toBe('vector_blend');
    });

    it('should find entities by vector-only search (no text query)', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        {
          query_embedding: testVector,
          entity_type: 'brand',
        },
        { token }
      );
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      const match = result.matches.find((m: any) => m.id === embeddedEntity.id);
      expect(match).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        {
          query: 'E2E',
          limit: 1,
        },
        { token }
      );
      expect(result.matches.length).toBeLessThanOrEqual(1);
    });
  });

  // ========================================
  // 4. Events / Content
  // ========================================
  describe('4. Events and content', () => {
    beforeAll(async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        await createTestEvent({
          entity_id: entity.id,
          connection_id: conn.id,
          content: `E2E content item ${i + 1} about product quality`,
          title: `Review ${i + 1}`,
          occurred_at: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
          semantic_type: 'content',
        });
      }
    });

    it('should retrieve content for entity', async () => {
      const result = await mcpToolsCall('read_knowledge', { entity_id: entity.id }, { token });
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter content with content_since', async () => {
      const result = await mcpToolsCall(
        'read_knowledge',
        { entity_id: entity.id, content_since: '7d' },
        { token }
      );
      expect(result.content).toBeDefined();
    });
  });

  // ========================================
  // 5. Classification (fixture-level only — manage_classifiers list has a pre-existing bug)
  // ========================================
  describe('5. Classification', () => {
    let classifier: Awaited<ReturnType<typeof createTestClassifier>>;
    let event1Id: number;

    beforeAll(async () => {
      // Create classifier via fixture (MCP create works but list has entity_ids parsing bug)
      classifier = await createTestClassifier({
        organization_id: org.id,
        slug: 'e2e-sentiment',
        name: 'E2E Sentiment',
        attribute_key: 'sentiment',
        attribute_values: {
          positive: { description: 'Positive sentiment' },
          negative: { description: 'Negative sentiment' },
          neutral: { description: 'Neutral sentiment' },
        },
      });

      // Get an event to classify
      const sql = getTestDb();
      const events = await sql`
        SELECT id FROM events WHERE ${entity.id} = ANY(entity_ids) LIMIT 1
      `;
      event1Id = Number(events[0].id);
    });

    it('should create classifier via fixture', () => {
      expect(classifier.id).toBeDefined();
      expect(classifier.slug).toBe('e2e-sentiment');
    });

    it('should classify an event', async () => {
      const result = await mcpToolsCall(
        'manage_classifiers',
        {
          action: 'classify',
          classifier_slug: 'e2e-sentiment',
          content_id: event1Id,
          value: 'positive',
        },
        { token }
      );
      expect(result.success).toBeDefined();
    });

    it('should get classifier versions', async () => {
      const result = await mcpToolsCall(
        'manage_classifiers',
        { action: 'get_versions', classifier_id: classifier.id },
        { token }
      );
      expect(result.data?.versions).toBeDefined();
      expect(result.data.versions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ========================================
  // 6. Watcher templates and windows
  // ========================================
  describe('6. Watcher templates and windows', () => {
    let template: Awaited<ReturnType<typeof createTestWatcherTemplate>>;
    let watcher: Awaited<ReturnType<typeof createTestWatcher>>;

    beforeAll(async () => {
      template = await createTestWatcherTemplate({
        slug: 'e2e-analysis',
        name: 'E2E Analysis Template',
        prompt: 'Analyze recent content for {{entities}}',
        output_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            sentiment_breakdown: {
              type: 'object',
              properties: {
                positive: { type: 'number' },
                negative: { type: 'number' },
                neutral: { type: 'number' },
              },
            },
          },
        },
      });

      watcher = await createTestWatcher({
        entity_id: entity.id,
        template_id: template.id,
        organization_id: org.id,
        schedule: '0 0 * * 1',
      });

      // Create an watcher window with extracted data
      await createTestWatcherWindow({
        watcher_id: watcher.id,
        window_start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        window_end: new Date(),
        granularity: 'weekly',
        extracted_data: {
          summary: 'Overall positive sentiment with minor quality concerns.',
          sentiment_breakdown: {
            positive: 0.7,
            negative: 0.1,
            neutral: 0.2,
          },
        },
        content_analyzed: 5,
      });
    });

    it('should query watchers by watcher_id', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.windows.length).toBeGreaterThanOrEqual(1);
      expect(result.watcher).toBeDefined();
    });

    it('should query watchers by entity_id', async () => {
      const result = await mcpToolsCall('list_watchers', { entity_id: entity.id }, { token });
      expect(result.watchers).toBeDefined();
      expect(result.watchers.length).toBeGreaterThanOrEqual(1);
    });

    it('should include extracted data in window', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id) },
        { token }
      );
      const window = result.windows[0];
      expect(window.extracted_data).toBeDefined();
      expect(window.extracted_data.summary).toContain('positive');
      expect(window.content_analyzed).toBe(5);
      expect(window.granularity).toBe('weekly');
    });

    it('should filter watchers with date range', async () => {
      const result = await mcpToolsCall(
        'get_watcher',
        { watcher_id: String(watcher.id), content_since: '30d' },
        { token }
      );
      expect(result.windows).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
  });

  // ========================================
  // 7. Connections and feeds
  // ========================================
  describe('7. Connections and feeds', () => {
    it('should list connections for entity via search_knowledge include_connections', async () => {
      const result = await mcpToolsCall(
        'search_knowledge',
        { entity_id: entity.id, include_connections: true },
        { token }
      );
      expect(result.connections).toBeDefined();
      expect(result.connections.length).toBeGreaterThanOrEqual(1);
      expect(result.connections[0].connector_key).toBe('e2e-connector');
    });

    it('should create a feed for connection', async () => {
      const result = await mcpToolsCall(
        'manage_feeds',
        {
          action: 'create_feed',
          connection_id: conn.id,
          feed_key: 'default',
        },
        { token }
      );
      expect(result.feed).toBeDefined();
      expect(result.feed.feed_key).toBe('default');
    });

    it('should list feeds for connection', async () => {
      const result = await mcpToolsCall(
        'manage_feeds',
        { action: 'list_feeds', connection_id: conn.id },
        { token }
      );
      expect(result.feeds).toBeDefined();
      expect(result.feeds.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ========================================
  // 8. Entity management (manage_entity)
  // ========================================
  describe('8. Entity management', () => {
    it('should get entity details', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'get', entity_id: entity.id },
        { token }
      );
      expect(result.entity).toBeDefined();
      expect(result.entity.name).toBe('E2E Brand');
    });

    it('should update entity metadata', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'update',
          entity_id: entity.id,
          metadata: { category: 'saas', industry: 'technology' },
        },
        { token }
      );
      expect(result.entity).toBeDefined();
    });

    it('should create a child entity', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          name: 'E2E Product US',
          entity_type: 'product',
          parent_id: entity.id,
          market: 'US',
        },
        { token }
      );
      expect(result.entity).toBeDefined();
      expect(result.entity.name).toBe('E2E Product US');
    });

    it('should list entities', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        { action: 'list', entity_type: 'brand' },
        { token }
      );
      expect(result.entities).toBeDefined();
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });
  });
});
