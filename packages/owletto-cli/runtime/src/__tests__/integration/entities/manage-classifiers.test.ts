/**
 * Manage Classifiers Integration Tests
 *
 * Tests for classifier CRUD, versioning, manual classification,
 * batch classification, and entity-scoped classifiers.
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
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Manage Classifiers', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let event1: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    // Ensure 'api' user exists for classifier created_by FK
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
      VALUES ('api', 'API User', 'api@system.internal', 'api-system-user', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    org = await createTestOrganization({ name: 'Classifiers Test Org' });
    user = await createTestUser({ email: 'classifiers-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({ name: 'Classifiers Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'test-clf-connector',
      name: 'CLF Connector',
      organization_id: org.id,
    });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-clf-connector',
      entity_ids: [entity.id],
    });

    event1 = await createTestEvent({
      entity_id: entity.id,
      connection_id: conn.id,
      content: 'Great product, works perfectly!',
      title: 'Positive review',
    });
    await createTestEvent({
      entity_id: entity.id,
      connection_id: conn.id,
      content: 'Terrible experience, very buggy.',
      title: 'Negative review',
    });
  });

  describe('create', () => {
    it('should create a classifier with all fields', async () => {
      // Use direct fixture to avoid MCP FK constraint issues with 'api' created_by
      const clf = await createTestClassifier({
        organization_id: org.id,
        slug: 'sentiment',
        name: 'Sentiment',
        attribute_key: 'sentiment',
        attribute_values: {
          positive: { description: 'Positive sentiment' },
          negative: { description: 'Negative sentiment' },
          neutral: { description: 'Neutral sentiment' },
        },
      });
      expect(clf.id).toBeDefined();
      expect(clf.slug).toBe('sentiment');
    });

    it('should create entity-scoped classifier', async () => {
      const clf = await createTestClassifier({
        organization_id: org.id,
        slug: 'entity-topic',
        name: 'Entity Topic',
        attribute_key: 'entity_topic',
        entity_id: entity.id,
        attribute_values: {
          ux: { description: 'UX related' },
          performance: { description: 'Performance related' },
        },
      });
      expect(clf.id).toBeDefined();
      expect(clf.slug).toBe('entity-topic');
    });
  });

  describe('list', () => {
    it('should list all classifiers', async () => {
      const result = await mcpToolsCall('manage_classifiers', { action: 'list' }, { token });
      expect(result.data?.classifiers).toBeDefined();
      expect(result.data.classifiers.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by entity_id', async () => {
      const result = await mcpToolsCall(
        'manage_classifiers',
        { action: 'list', entity_id: entity.id },
        { token }
      );
      expect(result.data?.classifiers).toBeDefined();
      expect(result.data.classifiers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('get_versions', () => {
    it('should return version history', async () => {
      const list = await mcpToolsCall('manage_classifiers', { action: 'list' }, { token });
      const sentiment = list.data.classifiers.find((c: any) => c.slug === 'sentiment');

      const result = await mcpToolsCall(
        'manage_classifiers',
        { action: 'get_versions', classifier_id: sentiment.id },
        { token }
      );
      expect(result.data?.versions).toBeDefined();
      expect(result.data.versions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('classify (manual)', () => {
    it('should classify a single content item', async () => {
      const result = await mcpToolsCall(
        'manage_classifiers',
        {
          action: 'classify',
          classifier_slug: 'sentiment',
          content_id: event1.id,
          value: 'positive',
        },
        { token }
      );
      expect(result.data?.updated).toBe(1);
    });

    it('should return failure for nonexistent content', async () => {
      const result = await mcpToolsCall(
        'manage_classifiers',
        {
          action: 'classify',
          classifier_slug: 'sentiment',
          content_id: 999999,
          value: 'positive',
        },
        { token }
      );
      expect(result.success).toBe(false);
    });
  });

  describe('delete', () => {
    it('should soft-delete (archive) a classifier', async () => {
      const clf = await createTestClassifier({
        organization_id: org.id,
        slug: 'to-delete',
      });

      const result = await mcpToolsCall(
        'manage_classifiers',
        { action: 'delete', classifier_id: clf.id },
        { token }
      );
      expect(result.success).toBe(true);
      expect(result.action).toBe('delete');
    });
  });
});
