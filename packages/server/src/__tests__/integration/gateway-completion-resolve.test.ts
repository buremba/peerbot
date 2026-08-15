/**
 * `resolveCompletionTarget` protocol gating, against REAL provider rows.
 *
 * These features speak ONE wire protocol: OpenAI-compatible
 * `POST {baseUrl}/chat/completions`. A provider whose upstream speaks anything
 * else must resolve to null so the caller fails open, rather than posting a
 * chat/completions body somewhere that cannot parse it.
 *
 * A real row is required: the resolver returns null on a missing credential
 * LONG before it reaches the protocol check, so a registry-only test would
 * pass even with the check deleted.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetEncryptionKeyCacheForTests,
  moduleRegistry,
  type ModuleInterface,
} from '@lobu/core';
import { createInferenceProvider } from '../../lobu/stores/provider-secrets';
import { resolveCompletionTarget } from '../../gateway/inference/gateway-completion';
import { getDb } from '../../db/client';
import { cleanupTestDatabase } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const registry = moduleRegistry as unknown as {
  modules: Map<string, ModuleInterface>;
};

let savedModules: Map<string, ModuleInterface>;

beforeAll(() => {
  process.env.LOBU_ENCRYPTION_KEY ||= 'a'.repeat(64);
  __resetEncryptionKeyCacheForTests();
  savedModules = new Map(registry.modules);
});

// The registry is process-global; a module leaking into the next test would
// silently change which one wins the providerId lookup.
afterEach(() => {
  registry.modules = new Map(savedModules);
});

afterAll(async () => {
  registry.modules = savedModules;
  await cleanupTestDatabase();
});

async function newOrgWithProvider(slug: string, model: string) {
  const org = await createTestOrganization();
  const orgId = org.id;
  const created = await createInferenceProvider({
    organizationId: orgId,
    slug,
    kind: slug,
    apiKey: 'sk-resolver-test',
    capabilities: { text: { model } },
  });
  if ('error' in created) throw new Error(`create failed: ${created.error}`);
  // main does not auto-promote; flag it so the resolver has a default to read.
  await getDb()`
    UPDATE inference_providers SET is_default = true
    WHERE organization_id = ${orgId} AND slug = ${slug}
  `;
  return orgId;
}

/** A second, NON-default provider in an existing org. */
async function addProvider(orgId: string, slug: string, model: string) {
  const created = await createInferenceProvider({
    organizationId: orgId,
    slug,
    kind: slug,
    apiKey: `sk-${slug}-test`,
    capabilities: { text: { model } },
  });
  if ('error' in created) throw new Error(`create failed: ${created.error}`);
}

function register(module: Record<string, unknown>) {
  moduleRegistry.register({
    isEnabled: () => true,
    getSecretEnvVarNames: () => [],
    ...module,
  } as unknown as ModuleInterface);
}

function registerOpenAiCompatible(providerId: string, upstreamBaseUrl: string) {
  register({
    name: `${providerId}-api-key`,
    providerId,
    providerDisplayName: providerId,
    sdkCompat: 'openai',
    getUpstreamConfig: () => ({ slug: providerId, upstreamBaseUrl }),
  });
}

describe('resolveCompletionTarget protocol gating', () => {
  /**
   * The ChatGPT subscription provider resolves to null, and that is CORRECT.
   *
   * Its upstream is `chatgpt.com/backend-api` — Codex's subscription backend,
   * not an OpenAI-compatible `/chat/completions` API. Its models endpoint
   * returns `{models:[{slug,title}]}` rather than OpenAI's `{data:[{id}]}`
   * (chatgpt-oauth-module.ts:94), and that module's comment records the
   * incident where an `openai/<model>` request leaking to this host returned
   * `403` without a ChatGPT session. Treating "undefined sdkCompat" as
   * "probably OpenAI" would re-create exactly that misroute.
   *
   * providers.json used to declare `sdkCompat: "openai"` for this id. It was
   * inert — the specialized module claims the id first and the config loop
   * skips it — but it was still a false claim about the wire protocol, so it
   * has been removed. `sdkCompatIsNotDeclaredForChatgpt` below pins that.
   *
   * If ChatGPT should ever back these features, the fix is to give it a real
   * OpenAI-compatible upstream — not to loosen this check.
   */
  it('does NOT resolve a provider whose module leaves sdkCompat undefined', async () => {
    const orgId = await newOrgWithProvider('chatgpt', 'gpt-5');
    register({
      name: 'chatgpt-oauth',
      providerId: 'chatgpt',
      providerDisplayName: 'ChatGPT (subscription login)',
      // Deliberately absent — mirrors ChatGPTOAuthModule.
      getUpstreamConfig: () => ({
        slug: 'openai-codex',
        upstreamBaseUrl: 'https://chatgpt.com/backend-api',
      }),
    });

    expect(await resolveCompletionTarget(orgId)).toBeNull();
  });

  /**
   * The ordering is what makes the case above real, so assert it directly.
   *
   * providers.json DOES declare `sdkCompat: "openai"` for id `chatgpt`. It
   * never takes effect because core-services registers the specialized module
   * FIRST and the config loop then skips ids already claimed
   * (`registeredIds.has(id)`). `getModelProviderModules().find()` returns the
   * first match by providerId, so the OAuth module — sdkCompat undefined —
   * wins.
   *
   * Registering config-first inverts the outcome and the provider resolves.
   * A live e2e that got this order wrong reported a false failure, which is
   * what prompted pinning it.
   *
   * SCOPE: this simulates the two registry states directly; it does not import
   * core-services, so reordering the real registrations there would NOT fail
   * here. What it pins is the consequence — that whichever module wins the
   * providerId lookup decides the protocol — so the resolver's semantics under
   * each state is locked even though the wiring that produces them is not.
   */
  it('the specialized module wins over the config entry, and only because it registers first', async () => {
    const orgId = await newOrgWithProvider('chatgpt', 'gpt-5');

    // Config-first: providers.json's sdkCompat "openai" wins and it resolves.
    register({
      name: 'chatgpt-config-driven',
      providerId: 'chatgpt',
      providerDisplayName: 'ChatGPT',
      sdkCompat: 'openai',
      getUpstreamConfig: () => ({
        slug: 'chatgpt',
        upstreamBaseUrl: 'https://chatgpt.com/backend-api',
      }),
    });
    expect(await resolveCompletionTarget(orgId)).not.toBeNull();

    // Production order: specialized first, config skipped. Now it does not.
    registry.modules = new Map(savedModules);
    register({
      name: 'chatgpt-oauth',
      providerId: 'chatgpt',
      providerDisplayName: 'ChatGPT (subscription login)',
      getUpstreamConfig: () => ({
        slug: 'openai-codex',
        upstreamBaseUrl: 'https://chatgpt.com/backend-api',
      }),
    });
    expect(await resolveCompletionTarget(orgId)).toBeNull();
  });

  /**
   * The config must not claim a protocol the upstream does not speak.
   *
   * This was inert (the specialized module wins the id), but a false entry is
   * a trap: `buildProviderCatalog` resolves `config?.sdkCompat ?? module…`, so
   * config wins wherever it IS consulted. With it removed, the catalog, the
   * API-key creation gate in agent-routes.ts, and this resolver all agree that
   * chatgpt is not routable as OpenAI.
   */
  it('providers.json does not declare an OpenAI protocol for chatgpt', async () => {
    const cfg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../../../config/providers.json'), 'utf8'),
    ) as { providers: Array<{ id: string; providers: Array<{ sdkCompat?: string }> }> };
    const chatgpt = cfg.providers.find((g) => g.id === 'chatgpt');
    expect(chatgpt).toBeDefined();
    expect(chatgpt?.providers[0]?.sdkCompat).toBeUndefined();
  });

  /**
   * `modelRef` overrides — the branch a guardrail's `model` field drives.
   *
   * Historically that field held a RAW model id (`gpt-4o-mini`) posted to one
   * operator-configured base URL. Now that credentials come from provider rows
   * a ref may ALSO be `<slug>/<model>`, and the two cannot be told apart by
   * looking for a "/": provider-native ids contain them (`anthropic/claude-…`,
   * `nvidia/moonshotai/kimi-k2.6`). So the resolver tries the prefix as a slug
   * and only accepts that reading if the org has such a row.
   *
   * All of this was previously untested — every other case here resolves the
   * org default with no ref at all.
   */
  describe('modelRef override', () => {
    it('a qualified <slug>/<model> ref routes to THAT provider, not the default', async () => {
      const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
      await addProvider(orgId, 'together-ai', 'Qwen/Qwen2.5-72B-Instruct-Turbo');
      registerOpenAiCompatible('groq', 'https://api.groq.com/openai/v1');
      registerOpenAiCompatible('together-ai', 'https://api.together.xyz/v1');

      const target = await resolveCompletionTarget(orgId, 'together-ai/deepseek-ai/DeepSeek-V3');
      // The ref names a real row, so the prefix IS the slug — and the rest of
      // the string stays whole, slashes included.
      expect(target?.baseUrl).toBe('https://api.together.xyz/v1');
      expect(target?.model).toBe('deepseek-ai/DeepSeek-V3');
    });

    it('a BARE model ref borrows the default provider credentials', async () => {
      const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
      registerOpenAiCompatible('groq', 'https://api.groq.com/openai/v1');

      const target = await resolveCompletionTarget(orgId, 'llama-3.1-8b-instant');
      // No "/" at all: the operator's raw model id runs on the org default.
      expect(target?.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(target?.model).toBe('llama-3.1-8b-instant');
    });

    it('a provider-native ref whose prefix is NOT a row is kept whole', async () => {
      const orgId = await newOrgWithProvider('openrouter', 'auto');
      registerOpenAiCompatible('openrouter', 'https://openrouter.ai/api/v1');

      // `anthropic/` is openrouter's MODEL namespace here, not a provider row.
      // Splitting on it would misroute to a provider the org does not have.
      const target = await resolveCompletionTarget(orgId, 'anthropic/claude-sonnet-5');
      expect(target?.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(target?.model).toBe('anthropic/claude-sonnet-5');
    });

    it('an override is skipped when the org has no default to borrow from', async () => {
      const org = await createTestOrganization();
      expect(await resolveCompletionTarget(org.id, 'some-model')).toBeNull();
    });
  });

  it('does NOT resolve an explicitly non-OpenAI protocol', async () => {
    const orgId = await newOrgWithProvider('anthropic', 'claude-sonnet-5');
    register({
      name: 'anthropic-api-key',
      providerId: 'anthropic',
      providerDisplayName: 'Anthropic',
      sdkCompat: 'anthropic',
      getUpstreamConfig: () => ({
        slug: 'anthropic',
        upstreamBaseUrl: 'https://api.anthropic.com',
      }),
    });

    expect(await resolveCompletionTarget(orgId)).toBeNull();
  });

  /** The positive control: same shape, only sdkCompat differs. */
  it('DOES resolve an OpenAI-compatible module', async () => {
    const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
    register({
      name: 'groq-api-key',
      providerId: 'groq',
      providerDisplayName: 'Groq',
      sdkCompat: 'openai',
      getUpstreamConfig: () => ({
        slug: 'groq',
        upstreamBaseUrl: 'https://api.groq.com/openai/v1',
      }),
    });

    const target = await resolveCompletionTarget(orgId);
    expect(target).not.toBeNull();
    expect(target?.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(target?.model).toBe('llama-3.3-70b-versatile');
  });
});
