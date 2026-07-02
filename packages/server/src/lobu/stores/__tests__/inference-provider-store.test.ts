/**
 * Inference-provider store round-trip — runs against whichever backend
 * globalSetup selected (ephemeral embedded Postgres with `bun run test`, real
 * Postgres with DATABASE_URL set). Needs a DB: exercises the full create →
 * list → read-key → merge-capabilities → soft-delete → recreate cycle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTestDatabase,
  getTestDb,
} from '../../../__tests__/setup/test-db';
import {
  createInferenceProvider,
  getInferenceProviderBySlug,
  listInferenceProviders,
  resolveInferenceProviderConfig,
  rotateInferenceProviderKey,
  softDeleteInferenceProvider,
  updateInferenceProviderCapabilities,
} from '../provider-secrets';

/** Read the decrypted key back via the consolidated resolver (text block). */
const readKey = async (org: string, slug: string) =>
  (await resolveInferenceProviderConfig(org, slug, 'text'))?.apiKey ?? null;

const ORG = 'org-inference-test';

describe('inference-provider store', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE inference_providers, agent_secrets`;
  });

  it('runs the full create → list → read → update → delete → recreate cycle', async () => {
    // ── create ────────────────────────────────────────────────────────────
    const created = await createInferenceProvider({
      organizationId: ORG,
      slug: 'openai',
      kind: 'openai',
      displayName: 'OpenAI',
      apiKey: 'sk-secret-value',
      capabilities: { text: { model: 'gpt-x' } },
      createdBy: 'user-1',
    });
    if ('error' in created) throw new Error('expected create to succeed');
    expect(created.slug).toBe('openai');
    expect(created.apiKeyRef).toBe(`secret://${ORG}/openai-${created.id}`);
    expect(created.capabilities).toEqual({ text: { model: 'gpt-x' } });

    // ── list never leaks the key or the ref ───────────────────────────────
    const list = await listInferenceProviders(ORG);
    expect(list).toHaveLength(1);
    const listed = list[0] as Record<string, unknown>;
    expect(listed.slug).toBe('openai');
    expect(JSON.stringify(listed)).not.toContain('sk-secret-value');
    expect(listed).not.toHaveProperty('apiKeyRef');
    expect(listed).not.toHaveProperty('api_key_ref');
    expect(listed).not.toHaveProperty('ciphertext');

    // ── read the key back ─────────────────────────────────────────────────
    expect(await readKey(ORG, 'openai')).toBe('sk-secret-value');

    // ── merge capabilities: a second modality must not clobber the first ───
    const updated = await updateInferenceProviderCapabilities(
      ORG,
      'openai',
      'image',
      { base_url: 'https://images.example.com', model: 'dall-e' }
    );
    expect(updated).not.toBeNull();
    expect(updated?.capabilities).toEqual({
      text: { model: 'gpt-x' },
      image: { base_url: 'https://images.example.com', model: 'dall-e' },
    });
    // has_custom_upstream flips true once any base_url is present.
    expect(updated?.hasCustomUpstream).toBe(true);

    // ── rotate the key (same immutable ref) ───────────────────────────────
    expect(await rotateInferenceProviderKey(ORG, 'openai', 'sk-rotated')).toBe(
      true
    );
    expect(await readKey(ORG, 'openai')).toBe('sk-rotated');

    // ── soft-delete ───────────────────────────────────────────────────────
    expect(await softDeleteInferenceProvider(ORG, 'openai')).toBe(true);
    expect(await getInferenceProviderBySlug(ORG, 'openai')).toBeNull();
    expect(await listInferenceProviders(ORG)).toHaveLength(0);

    // ── recreate the same slug succeeds (fresh id, fresh keyref) ──────────
    // Give it a text block so the key is resolvable via the modality resolver.
    const recreated = await createInferenceProvider({
      organizationId: ORG,
      slug: 'openai',
      kind: 'openai',
      apiKey: 'sk-brand-new',
      capabilities: { text: { model: 'gpt-x' } },
      createdBy: 'user-2',
    });
    if ('error' in recreated) throw new Error('expected recreate to succeed');
    expect(recreated.id).not.toBe(created.id);
    expect(recreated.apiKeyRef).toBe(`secret://${ORG}/openai-${recreated.id}`);
    expect(await readKey(ORG, 'openai')).toBe('sk-brand-new');
  });

  it('returns a typed slug_conflict on a live duplicate slug', async () => {
    const first = await createInferenceProvider({
      organizationId: ORG,
      slug: 'groq',
      kind: 'groq',
      apiKey: 'k1',
    });
    expect('error' in first).toBe(false);

    const second = await createInferenceProvider({
      organizationId: ORG,
      slug: 'groq',
      kind: 'groq',
      apiKey: 'k2',
    });
    expect(second).toEqual({ error: 'slug_conflict', slug: 'groq' });
  });

  it('returns null when updating capabilities for a missing slug', async () => {
    const res = await updateInferenceProviderCapabilities(
      ORG,
      'does-not-exist',
      'text',
      { model: 'x' }
    );
    expect(res).toBeNull();
  });
});
