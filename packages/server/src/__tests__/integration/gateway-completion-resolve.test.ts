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

function register(module: Record<string, unknown>) {
  moduleRegistry.register({
    isEnabled: () => true,
    getSecretEnvVarNames: () => [],
    ...module,
  } as unknown as ModuleInterface);
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
   * exactly why this is pinned: if someone moves the config loop above the
   * specialized registrations, chat completions would start egressing to
   * chatgpt.com/backend-api.
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
