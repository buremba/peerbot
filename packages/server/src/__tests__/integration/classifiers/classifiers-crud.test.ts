/**
 * Classifier CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted manage_classifiers integration tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('classifier CRUD', () => {
  let owner: TestApiClient;
  let entityId: number;
  let watcherId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Classifier Test Org' });
    const user = await createTestUser({ email: 'cls-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Classifier Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;

    const w = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'cls-watcher',
      name: 'Classifier Watcher',
      prompt: 'gather signals.',
      extraction_schema: {
        type: 'object',
        properties: { signal: { type: 'string' } },
      },
    })) as { watcher_id: string };
    watcherId = Number(w.watcher_id);
  });

  it('creates → reads back → deletes a classifier', async () => {
    // Provide embeddings directly so the test doesn't depend on a live
    // EMBEDDINGS_SERVICE_URL — the values themselves are arbitrary.
    const stubEmbedding = Array.from({ length: 768 }, () => 0);
    const created = (await owner.classifiers.create({
      slug: 'sentiment',
      name: 'Sentiment',
      attribute_key: 'sentiment',
      watcher_id: watcherId,
      attribute_values: {
        positive: { description: 'positive sentiment', examples: ['great'], embedding: stubEmbedding },
        negative: { description: 'negative sentiment', examples: ['bad'], embedding: stubEmbedding },
      },
    })) as { data?: { classifier_id: number } };
    expect(created.data?.classifier_id).toBeGreaterThan(0);
    const classifierId = created.data!.classifier_id;

    // List with no filter — the classifier is attached to a watcher, not an
    // entity, so list({entity_id}) wouldn't include it.
    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };
    expect(list.data?.classifiers?.some((c) => c.id === classifierId)).toBe(true);

    await owner.classifiers.delete(classifierId);
  });

  it('blocks a member from creating classifiers (admin-only)', async () => {
    const member = owner.withAuth({ memberRole: 'member' });
    const stubEmbedding = Array.from({ length: 768 }, () => 0);
    await expect(
      member.classifiers.create({
        slug: 'blocked-cls',
        name: 'Blocked',
        attribute_key: 'sentiment',
        watcher_id: watcherId,
        attribute_values: {
          v: { description: 'v', examples: ['v'], embedding: stubEmbedding },
        },
      })
    ).rejects.toThrow(/admin|owner|access/i);
  });
});
