/**
 * Integration test: an org always has a resolvable default inference provider.
 *
 * The org default is the tail of the layered model fallback
 * (behavior → agent → org default). When it is missing, `getOrgDefaultModel`
 * returns null and EVERY org-scoped model consumer silently no-ops — no error,
 * no UI signal, just nothing happening.
 *
 * Prod showed both halves of that failure on 2026-07-28: no live row anywhere
 * carried `is_default`, and the only row that did was soft-deleted. The two
 * causes this file pins down:
 *   (a) creating a provider never marked it default — that was a SEPARATE
 *       explicit call nothing chained to creation, so a one-provider org had
 *       no default despite there being only one sensible answer;
 *   (b) deleting the default left the org with none.
 *
 * Harness: vitest + real Postgres, matching the other store-level suites.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetEncryptionKeyCacheForTests } from '@lobu/core';
import {
  createInferenceProvider,
  getOrgDefaultModel,
  listInferenceProviders,
  setInferenceProviderDefault,
  softDeleteInferenceProvider,
} from '../../lobu/stores/provider-secrets';
import { getDb } from '../../db/client';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

let originalEncryptionKey: string | undefined;

async function newOrg() {
  return await createTestOrganization({ name: 'Provider Default Org' });
}

/** Create a provider, failing loudly on a slug conflict. */
async function create(
  organizationId: string,
  slug: string,
  model?: string,
) {
  const result = await createInferenceProvider({
    organizationId,
    slug,
    kind: slug,
    apiKey: `sk-${slug}`,
    capabilities: model ? { text: { model } } : {},
  });
  if ('error' in result) throw new Error(`unexpected conflict for ${slug}`);
  return result;
}

async function defaultSlug(organizationId: string): Promise<string | null> {
  const rows = (await getDb()`
    SELECT slug FROM inference_providers
    WHERE organization_id = ${organizationId} AND is_default AND deleted_at IS NULL
  `) as Array<{ slug: string }>;
  return rows[0]?.slug ?? null;
}

describe('inference provider org default', () => {
  beforeAll(async () => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    __resetEncryptionKeyCacheForTests();
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    __resetEncryptionKeyCacheForTests();
  });

  it('(a) the first provider an org creates becomes its default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');

    expect(await defaultSlug(org.id)).toBe('openai');
    // The whole point: a model now resolves org-wide.
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(b) later providers do NOT steal the default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await create(org.id, 'xai', 'grok-4');

    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(c) deleting the default promotes the oldest survivor', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await create(org.id, 'xai', 'grok-4');
    expect(await defaultSlug(org.id)).toBe('openai');

    expect(await softDeleteInferenceProvider(org.id, 'openai')).toBe(true);

    // z-ai was created before xai, so it inherits.
    expect(await defaultSlug(org.id)).toBe('z-ai');
    expect(await getOrgDefaultModel(org.id)).toBe('z-ai/glm-4.6');
  });

  it('(d) deleting a NON-default provider leaves the default alone', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');

    expect(await softDeleteInferenceProvider(org.id, 'z-ai')).toBe(true);
    expect(await defaultSlug(org.id)).toBe('openai');
  });

  it('(e) deleting the last provider is a no-op, not a crash', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');

    expect(await softDeleteInferenceProvider(org.id, 'openai')).toBe(true);
    expect(await defaultSlug(org.id)).toBeNull();
    expect(await getOrgDefaultModel(org.id)).toBeNull();
  });

  it('(f) re-creating after deleting everything defaults again', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await softDeleteInferenceProvider(org.id, 'openai');

    // A soft-deleted row must not count as "already has a provider", or the
    // org could never recover a default.
    await create(org.id, 'z-ai', 'glm-4.6');
    expect(await defaultSlug(org.id)).toBe('z-ai');
  });

  it('(g) an explicit set-default still wins over the auto-assignment', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');

    expect(await setInferenceProviderDefault(org.id, 'z-ai')).toBe(true);
    expect(await defaultSlug(org.id)).toBe('z-ai');
    // Exactly one default survives the switch (partial unique index).
    const providers = await listInferenceProviders(org.id);
    expect(providers.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('(h) two orgs each keep their own default', async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    await create(orgA.id, 'openai', 'gpt-4o-mini');
    await create(orgB.id, 'z-ai', 'glm-4.6');

    expect(await getOrgDefaultModel(orgA.id)).toBe('openai/gpt-4o-mini');
    expect(await getOrgDefaultModel(orgB.id)).toBe('z-ai/glm-4.6');
  });
});
