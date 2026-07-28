/**
 * Integration coverage for automatic org-default assignment, legacy repair,
 * OAuth defaults, and promotion after deletion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetEncryptionKeyCacheForTests } from '@lobu/core';
import {
  createInferenceProvider,
  ensureOAuthInferenceProvider,
  getOrgDefaultModel,
  listInferenceProviders,
  setInferenceProviderDefault,
  softDeleteInferenceProvider,
  updateInferenceProviderCapabilities,
} from '../../lobu/stores/provider-secrets';
import { resolveCompletionTarget } from '../../gateway/inference/gateway-completion';
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

  it('(a) the first runnable provider an org creates becomes its default', async () => {
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

  it('(e) deleting the last provider leaves the org without a default', async () => {
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

  it('(i) repairs a legacy org whose live providers have no default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await getDb()`
      UPDATE inference_providers
      SET is_default = false
      WHERE organization_id = ${org.id}
    `;

    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
    expect(await defaultSlug(org.id)).toBe('openai');
  });

  it('(j) an OAuth provider can become the runnable org default', async () => {
    const org = await newOrg();
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'claude',
      kind: 'claude',
      defaultModel: 'claude-sonnet-5',
    });

    expect(await getOrgDefaultModel(org.id)).toBe('claude/claude-sonnet-5');
    expect(await defaultSlug(org.id)).toBe('claude');
  });

  it('(k) an explicit model resolves with a row key and static OpenAI URL', async () => {
    const org = await newOrg();
    await create(org.id, 'openai');

    const target = await resolveCompletionTarget(org.id, 'openai/gpt-4o-mini');
    expect(target?.baseUrl).toBeTruthy();
    expect(target?.apiKey).toBe('sk-openai');
    expect(target?.model).toBe('gpt-4o-mini');
  });

  it('(l) an unrunnable default is replaced by the oldest runnable provider', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await updateInferenceProviderCapabilities(org.id, 'openai', 'text', {});

    expect(await getOrgDefaultModel(org.id)).toBe('z-ai/glm-4.6');
    expect(await defaultSlug(org.id)).toBe('z-ai');
  });

  /**
   * The misrouting invariant, pinned to the resolver that now owns it.
   *
   * Sending a request to a guessed endpoint would mis-deliver it to the wrong
   * vendor with a model ID that vendor does not know — surfacing as a baffling
   * "400 <model> is not a valid model ID" rather than "this provider isn't
   * wired up". Returning null (feature skipped) is the correct failure: a
   * missing chip beats a wrong-vendor call. Mirrors `buildDynamicOpenAIModel`
   * in agent-worker/src/runtime/model-resolver.ts.
   */
  describe('misrouting invariant', () => {
    it('(m) an unregistered provider with no row base_url does NOT resolve', async () => {
      const org = await newOrg();
      // `kind` matches no registered module, so there is no upstream to
      // inherit — and it is not OpenAI, so it gets no public-endpoint default.
      await create(org.id, 'totally-unknown-vendor', 'some-model');

      expect(
        await resolveCompletionTarget(
          org.id,
          'totally-unknown-vendor/some-model'
        )
      ).toBeNull();
    });

    it('(n) a lookalike slug does not inherit the OpenAI public endpoint', async () => {
      const org = await newOrg();
      await create(org.id, 'openai-lookalike', 'gpt-4o-mini');

      expect(
        await resolveCompletionTarget(org.id, 'openai-lookalike/gpt-4o-mini')
      ).toBeNull();
    });

    it('(o) the org row base_url wins over any registered upstream', async () => {
      const org = await newOrg();
      const result = await createInferenceProvider({
        organizationId: org.id,
        slug: 'openai',
        kind: 'openai',
        apiKey: 'sk-tenant',
        capabilities: {
          text: { base_url: 'https://tenant.example/v1', model: 'gpt-4o-mini' },
        },
      });
      if ('error' in result) throw new Error('unexpected conflict');

      expect((await resolveCompletionTarget(org.id))?.baseUrl).toBe(
        'https://tenant.example/v1'
      );
    });

    it('(p) an OAuth-backed row has no API key, so it never resolves a target', async () => {
      const org = await newOrg();
      await ensureOAuthInferenceProvider({
        organizationId: org.id,
        slug: 'claude',
        kind: 'claude',
        defaultModel: 'claude-sonnet-5',
      });

      // It IS the org default (see (j)) — but an oauth:// ref joins to no vault
      // secret, so the transport declines rather than sending a keyless
      // request. Claude is also sdkCompat:"anthropic", the one non-OpenAI
      // protocol in the registry.
      expect(await getOrgDefaultModel(org.id)).toBe('claude/claude-sonnet-5');
      expect(await resolveCompletionTarget(org.id)).toBeNull();
    });
  });
});
