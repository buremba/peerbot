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
  clearInferenceProviderError,
  createInferenceProvider,
  ensureOAuthInferenceProvider,
  getInferenceProviderBySlug,
  getOrgDefaultModel,
  listInferenceProviders,
  markInferenceProviderUnhealthy,
  readOrgSharedProviderApiKey,
  resolveInferenceProviderConfig,
  rotateInferenceProviderKey,
  setInferenceProviderDefault,
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
      'rotated'
    );
    expect(await readKey(ORG, 'openai')).toBe('sk-rotated');
    // The resolver-cutover reader (worker-spawn / egress tier) resolves the
    // same row-unique vault name.
    expect(await readOrgSharedProviderApiKey('openai', ORG)).toBe('sk-rotated');

    // ── rotate outcomes: missing slug / OAuth-backed row ──────────────────
    expect(
      await rotateInferenceProviderKey(ORG, 'no-such-slug', 'sk-x')
    ).toBe('not_found');

    // ── soft-delete ───────────────────────────────────────────────────────
    expect(await softDeleteInferenceProvider(ORG, 'openai')).toBe(true);
    expect(await getInferenceProviderBySlug(ORG, 'openai')).toBeNull();
    expect(await listInferenceProviders(ORG)).toHaveLength(0);
    expect(await readOrgSharedProviderApiKey('openai', ORG)).toBeNull();

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

  it('repairs an existing same-slug secret row when OAuth signs in', async () => {
    const legacy = await createInferenceProvider({
      organizationId: ORG,
      slug: 'claude',
      kind: 'claude',
      displayName: 'Legacy Claude',
      apiKey: 'sk-old',
      capabilities: {
        text: { base_url: 'https://tenant.example.com/v1', model: 'claude-x' },
      },
    });
    if ('error' in legacy) throw new Error('expected legacy create to succeed');

    const repaired = await ensureOAuthInferenceProvider({
      organizationId: ORG,
      slug: 'claude',
      kind: 'claude',
      displayName: 'Claude',
      createdBy: 'user-1',
    });

    expect(repaired.id).toBe(legacy.id);
    expect(repaired.apiKeyRef).toBe(`oauth://${ORG}/claude-${legacy.id}`);
    expect(repaired.displayName).toBe('Claude');
    expect(repaired.capabilities).toEqual({});
    expect(repaired.hasCustomUpstream).toBe(false);
    expect(await readKey(ORG, 'claude')).toBeNull();
    // The org-key tier must not serve the pre-repair vault key either — the
    // oauth:// ref never joins to a vault secret.
    expect(await readOrgSharedProviderApiKey('claude', ORG)).toBeNull();

    // Rotating an OAuth-backed row is rejected: a vault write would be
    // silently unread behind the oauth:// ref. Prove the vault is untouched
    // byte-for-byte, not merely unreadable.
    const db = getTestDb();
    const vaultBefore = await db`
      SELECT name, ciphertext FROM agent_secrets ORDER BY name
    `;
    expect(await rotateInferenceProviderKey(ORG, 'claude', 'sk-new')).toBe(
      'oauth_provider'
    );
    const vaultAfter = await db`
      SELECT name, ciphertext FROM agent_secrets ORDER BY name
    `;
    expect(Array.from(vaultAfter)).toEqual(Array.from(vaultBefore));
    expect(await readOrgSharedProviderApiKey('claude', ORG)).toBeNull();

    const listed = await getInferenceProviderBySlug(ORG, 'claude');
    expect(listed?.apiKeyRef).toBe(repaired.apiKeyRef);
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

  it('org default: flags one row and getOrgDefaultModel reads its text model', async () => {
    await createInferenceProvider({
      organizationId: ORG,
      slug: 'openai',
      kind: 'openai',
      apiKey: 'k1',
      capabilities: { text: { model: 'gpt-x' } },
    });
    await createInferenceProvider({
      organizationId: ORG,
      slug: 'groq',
      kind: 'groq',
      apiKey: 'k2',
      capabilities: { text: { model: 'llama-y' } },
    });

    // The first runnable provider becomes the default; `groq`, created second,
    // does not steal it.
    expect(await getOrgDefaultModel(ORG)).toBe('openai/gpt-x');

    // Mark openai the default → its text model is the org default, returned as
    // a routable `slug/model` ref (the worker derives the provider from the
    // prefix; a bare model would throw "No provider specified" there).
    expect(await setInferenceProviderDefault(ORG, 'openai')).toBe('ok');
    expect(await getOrgDefaultModel(ORG)).toBe('openai/gpt-x');
    expect(
      (await listInferenceProviders(ORG)).find((p) => p.slug === 'openai')
        ?.isDefault
    ).toBe(true);

    // Switching the default clears the prior one (one live default per org).
    expect(await setInferenceProviderDefault(ORG, 'groq')).toBe('ok');
    expect(await getOrgDefaultModel(ORG)).toBe('groq/llama-y');
    const after = await listInferenceProviders(ORG);
    expect(after.find((p) => p.slug === 'openai')?.isDefault).toBe(false);
    expect(after.find((p) => p.slug === 'groq')?.isDefault).toBe(true);
  });

  it('org default: prefixes a provider-native model id that already contains a slash', async () => {
    // openrouter/nvidia-style model ids carry slashes (`anthropic/claude-sonnet-5`).
    // The prefix must still be applied — otherwise the worker derives the wrong
    // provider from the first segment and misroutes. Only a `${slug}/…` ref is
    // already routable and left untouched.
    await createInferenceProvider({
      organizationId: ORG,
      slug: 'openrouter',
      kind: 'openrouter',
      apiKey: 'k1',
      capabilities: { text: { model: 'anthropic/claude-sonnet-5' } },
    });
    expect(await setInferenceProviderDefault(ORG, 'openrouter')).toBe('ok');
    expect(await getOrgDefaultModel(ORG)).toBe(
      'openrouter/anthropic/claude-sonnet-5'
    );
  });

  it('org default: does not double-prefix a model already carrying its own slug', async () => {
    await createInferenceProvider({
      organizationId: ORG,
      slug: 'openai',
      kind: 'openai',
      apiKey: 'k1',
      capabilities: { text: { model: 'openai/gpt-x' } },
    });
    expect(await setInferenceProviderDefault(ORG, 'openai')).toBe('ok');
    expect(await getOrgDefaultModel(ORG)).toBe('openai/gpt-x');
  });

  it('setInferenceProviderDefault returns not_found for a missing slug', async () => {
    expect(await setInferenceProviderDefault(ORG, 'does-not-exist')).toBe('not_found');
  });

  it('setting a missing slug default does NOT clear the existing default', async () => {
    await createInferenceProvider({
      organizationId: ORG,
      slug: 'openai',
      kind: 'openai',
      apiKey: 'k1',
      capabilities: { text: { model: 'gpt-x' } },
    });
    expect(await setInferenceProviderDefault(ORG, 'openai')).toBe('ok');
    expect(await getOrgDefaultModel(ORG)).toBe('openai/gpt-x');

    // A no-op on a missing slug must leave the current default intact.
    expect(await setInferenceProviderDefault(ORG, 'ghost')).toBe('not_found');
    expect(await getOrgDefaultModel(ORG)).toBe('openai/gpt-x');
  });
});

describe('inference-provider health writeback', () => {
  const createProvider = async (slug: string) => {
    const created = await createInferenceProvider({
      organizationId: ORG,
      slug,
      kind: 'openai',
      apiKey: 'k1',
      capabilities: { text: { model: 'gpt-x' } },
    });
    if ('error' in created) throw new Error(`expected ${slug} to be created`);
    return created;
  };

  const listed = async (slug: string) =>
    (await listInferenceProviders(ORG)).find((p) => p.slug === slug);

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE inference_providers, agent_secrets`;
  });

  it('marks a failing provider and surfaces the reason on the list', async () => {
    await createProvider('z-ai');
    expect((await listed('z-ai'))?.status).toBe('active');

    await markInferenceProviderUnhealthy(
      ORG,
      'z-ai',
      '429 Insufficient balance or no resource package'
    );

    const row = await listed('z-ai');
    expect(row?.status).toBe('error');
    expect(row?.errorMessage).toBe(
      '429 Insufficient balance or no resource package'
    );
    // updated_at dates the failure for the settings UI.
    expect(Date.parse(row?.updatedAt ?? '')).toBeGreaterThan(0);
  });

  it('truncates a runaway provider message instead of storing the payload', async () => {
    await createProvider('z-ai');

    await markInferenceProviderUnhealthy(ORG, 'z-ai', 'x'.repeat(5000));

    expect((await listed('z-ai'))?.errorMessage).toHaveLength(500);
  });

  it('clears the error after the provider serves a turn', async () => {
    await createProvider('z-ai');
    await markInferenceProviderUnhealthy(ORG, 'z-ai', 'no balance');

    await clearInferenceProviderError(ORG, 'z-ai');

    const row = await listed('z-ai');
    expect(row?.status).toBe('active');
    expect(row?.errorMessage).toBeNull();
  });

  it('never overwrites an operator-disabled provider in either direction', async () => {
    await createProvider('z-ai');
    const db = getTestDb();
    await db`
      UPDATE inference_providers SET status = 'disabled'
      WHERE organization_id = ${ORG} AND slug = 'z-ai'
    `;

    await markInferenceProviderUnhealthy(ORG, 'z-ai', 'no balance');
    expect((await listed('z-ai'))?.status).toBe('disabled');

    // Traffic must not re-enable what an operator switched off.
    await clearInferenceProviderError(ORG, 'z-ai');
    expect((await listed('z-ai'))?.status).toBe('disabled');
  });

  it('scopes both writes to the organization and the slug', async () => {
    await createProvider('z-ai');
    await createProvider('openai');
    const other = await createInferenceProvider({
      organizationId: 'org-other-tenant',
      slug: 'z-ai',
      kind: 'openai',
      apiKey: 'k2',
      capabilities: { text: { model: 'gpt-x' } },
    });
    if ('error' in other) throw new Error('expected other-tenant create');

    await markInferenceProviderUnhealthy(ORG, 'z-ai', 'no balance');

    expect((await listed('z-ai'))?.status).toBe('error');
    expect((await listed('openai'))?.status).toBe('active');
    const crossTenant = (await listInferenceProviders('org-other-tenant')).find(
      (p) => p.slug === 'z-ai'
    );
    expect(crossTenant?.status).toBe('active');
  });

  it('is a no-op for a soft-deleted provider', async () => {
    const created = await createProvider('z-ai');
    await softDeleteInferenceProvider(ORG, 'z-ai');

    await markInferenceProviderUnhealthy(ORG, 'z-ai', 'no balance');

    const db = getTestDb();
    const [row] = await db`
      SELECT status FROM inference_providers WHERE id = ${created.id}
    `;
    expect(row.status).toBe('active');
  });
});
