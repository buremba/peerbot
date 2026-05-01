/**
 * Classifier isolation contracts.
 *
 * These replace broad stale manage_classifiers tests with focused invariants:
 * classifiers are scoped to their workspace for list/read/mutate/classify.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-workspace';

const stubEmbedding = Array.from({ length: 768 }, () => 0);

type SeededClassifier = {
  workspace: TestWorkspace;
  entityId: number;
  watcherId: number;
  classifierId: number;
  eventId: number;
};

async function seedEntityType(workspace: TestWorkspace, slug: string, name: string) {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${workspace.org.id}, ${slug}, ${name}, NOW(), NOW())
  `;
}

async function seedClassifier(workspace: TestWorkspace, slug: string): Promise<SeededClassifier> {
  await seedEntityType(workspace, 'company', 'Company');
  const entity = (await workspace.owner.entities.create({
    type: 'company',
    name: `${slug} Target`,
  })) as { entity: { id: number } };

  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.entity.id,
    slug: `${slug}-watcher`,
    name: `${slug} Watcher`,
    prompt: 'collect signals.',
    extraction_schema: { type: 'object', properties: { signal: { type: 'string' } } },
  })) as { watcher_id: string };

  const created = (await workspace.owner.classifiers.create({
    slug,
    name: `${slug} Classifier`,
    attribute_key: slug,
    watcher_id: Number(watcher.watcher_id),
    attribute_values: {
      positive: { description: 'positive signal', examples: ['great'], embedding: stubEmbedding },
      negative: { description: 'negative signal', examples: ['bad'], embedding: stubEmbedding },
    },
  })) as { data?: { classifier_id: number } };

  const event = await createTestEvent({
    entity_id: entity.entity.id,
    organization_id: workspace.org.id,
    title: `${slug} event`,
    content: 'A workspace-local event.',
  });

  return {
    workspace,
    entityId: entity.entity.id,
    watcherId: Number(watcher.watcher_id),
    classifierId: created.data!.classifier_id,
    eventId: event.id,
  };
}

describe('classifier org isolation', () => {
  let orgA: SeededClassifier;
  let orgB: SeededClassifier;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const { a, b } = await TestWorkspace.pair();
    orgA = await seedClassifier(a, 'sentiment');
    orgB = await seedClassifier(b, 'sentiment');
  });

  it('list() only returns classifiers from the caller workspace', async () => {
    const listA = (await orgA.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };
    const listB = (await orgB.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };

    expect(listA.data?.classifiers?.some((c) => c.id === orgA.classifierId)).toBe(true);
    expect(listA.data?.classifiers?.some((c) => c.id === orgB.classifierId)).toBe(false);
    expect(listB.data?.classifiers?.some((c) => c.id === orgB.classifierId)).toBe(true);
    expect(listB.data?.classifiers?.some((c) => c.id === orgA.classifierId)).toBe(false);
  });

  it('getVersions() does not expose another workspace classifier', async () => {
    const versions = (await orgA.workspace.owner.classifiers.getVersions(orgB.classifierId)) as {
      data?: { versions?: unknown[] };
    };
    expect(versions.data?.versions ?? []).toHaveLength(0);
  });

  it('delete() cannot archive another workspace classifier', async () => {
    const result = (await orgA.workspace.owner.classifiers.delete(orgB.classifierId)) as {
      success: boolean;
    };
    expect(result.success).toBe(false);

    const listB = (await orgB.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; status: string }> };
    };
    expect(listB.data?.classifiers?.find((c) => c.id === orgB.classifierId)?.status).toBe('active');
  });

  it('classify() cannot write to another workspace event/classifier pair', async () => {
    const result = (await orgA.workspace.owner.classifiers.classify({
      classifier_slug: 'sentiment',
      content_id: orgB.eventId,
      value: 'positive',
    })) as { success: boolean; data?: { failed?: number } };

    expect(result.success).toBe(false);
    expect(result.data?.failed).toBe(1);
  });
});
