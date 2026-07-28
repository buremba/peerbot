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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
   * The ChatGPT subscription provider. It is registered by a SPECIALIZED module
   * (`ChatGPTOAuthModule`, core-services.ts) which claims `providerId:
   * "chatgpt"` BEFORE the config-driven loop runs — so providers.json's
   * `sdkCompat: "openai"` for that id is never applied and the winning module
   * leaves it undefined.
   *
   * Resolving to null is CORRECT here, not an oversight. Its upstream is
   * `chatgpt.com/backend-api` — Codex's subscription backend, not an
   * OpenAI-compatible `/chat/completions` API. The module's own comment records
   * the incident: an `openai/<model>` request that leaked to that host returned
   * `403` without a ChatGPT session. Treating "undefined sdkCompat" as
   * "probably OpenAI" would re-create exactly that misroute.
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
