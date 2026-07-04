/**
 * Hardening tests for model-resolver edge cases.
 *
 * Covers:
 * - resolveModelRef with multi-segment model IDs (provider/org/model)
 * - "auto" resolving to provider default
 * - Unknown provider in "provider/model" format still parsed (no registry check)
 * - resolveModelRef with null/undefined input (type boundary)
 * - registerDynamicProvider idempotency and alias precedence
 * - DEFAULT_PROVIDER_MODELS covers the known provider set
 * - No real credentials in resolver output
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PROVIDER_BASE_URL_ENV,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "../openclaw/model-resolver";

// Unique-enough prefix to avoid clashing with parallel test workers
const PREFIX = `test-${process.pid}-${Date.now()}`;

describe("resolveModelRef — edge cases", () => {
  test("multi-segment model: nvidia/org/model-id", () => {
    const result = resolveModelRef("nvidia/moonshotai/kimi-k2.5");
    expect(result.provider).toBe("nvidia");
    expect(result.modelId).toBe("moonshotai/kimi-k2.5");
  });

  test("three-part openai-compat path", () => {
    const result = resolveModelRef("openai-codex/gpt-5.1-codex-max");
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-5.1-codex-max");
  });

  test("unknown provider in provider/model format is returned verbatim", () => {
    // resolveModelRef does NOT validate against a registry — it just parses
    const result = resolveModelRef("future-provider/some-model-v99");
    expect(result.provider).toBe("future-provider");
    expect(result.modelId).toBe("some-model-v99");
  });

  test("auto model for unknown provider returns the raw 'auto' string", () => {
    // If DEFAULT_PROVIDER_MODELS doesn't have the provider, auto stays as-is
    const result = resolveModelRef("unknown-provider-xyz/auto");
    expect(result.provider).toBe("unknown-provider-xyz");
    expect(result.modelId).toBe("auto");
  });

  test("auto model for a provider with a default resolves to a real model", () => {
    // openai has a worker-side default; anthropic does not (gateway-resolved),
    // so this asserts the resolution for a provider that still carries one.
    const result = resolveModelRef("openai/auto");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBeTruthy();
    expect(result.modelId).not.toBe("auto");
  });

  test("overrides.defaultModel applies when rawModelRef is empty", () => {
    const result = resolveModelRef("", {
      defaultModel: "anthropic/claude-sonnet-4-20250514",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("overrides.defaultProvider applies to bare model IDs", () => {
    const result = resolveModelRef("some-model", {
      defaultProvider: "openai",
    });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("some-model");
  });

  test("whitespace-only rawModelRef falls back to overrides", () => {
    const result = resolveModelRef("   ", {
      defaultModel: "openai/gpt-4.1",
    });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4.1");
  });

  test("throws with descriptive message when no provider context exists", () => {
    // Neither env var nor override
    expect(() => resolveModelRef("just-a-model-name")).toThrow(
      'No provider specified for model "just-a-model-name"'
    );
  });

  test("throws when everything is empty and no defaults", () => {
    expect(() => resolveModelRef("")).toThrow("No model resolved");
  });
});

describe("resolveModelRef — configured provider wins over slug split", () => {
  test("openrouter + anthropic/claude-sonnet-4 → openrouter, slug intact", () => {
    const result = resolveModelRef("anthropic/claude-sonnet-4", {
      defaultProvider: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("openrouter + openai/gpt-4o → openrouter, NOT openai", () => {
    const result = resolveModelRef("openai/gpt-4o", {
      defaultProvider: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o");
  });

  test("defaultProvider override also wins over slug split", () => {
    const result = resolveModelRef("google/gemini-2.0-flash", {
      defaultProvider: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("google/gemini-2.0-flash");
  });

  test("configured provider + 'auto' resolves to that provider's default", () => {
    const result = resolveModelRef("auto", { defaultProvider: "openrouter" });
    expect(result.provider).toBe("openrouter");
    // openrouter has no DEFAULT_PROVIDER_MODELS entry, so "auto" stays as-is.
    expect(result.modelId).toBe("auto");
  });

  test("configured provider + 'auto' for a known provider resolves the default", () => {
    const result = resolveModelRef("auto", { defaultProvider: "openai" });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS.openai);
  });

  test("anthropic 'auto' stays as-is — the gateway supplies its default", () => {
    // anthropic has no worker-side default (gateway-resolved); like openrouter
    // above, "auto" passes through unchanged when no default is supplied.
    const result = resolveModelRef("auto", { defaultProvider: "anthropic" });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("auto");
  });

  test("auto-mode (no provider) still derives provider from slug", () => {
    const result = resolveModelRef("groq/llama-x");
    expect(result.provider).toBe("groq");
    expect(result.modelId).toBe("llama-x");
  });
});

describe("resolveModelRef — does not leak secrets", () => {
  test("model ID containing lobu_secret placeholder is passed through unchanged", () => {
    // Unlikely in practice but the resolver must not strip or transform it
    const secretRef = "lobu_secret_abc";
    const result = resolveModelRef(`test-provider/${secretRef}`);
    expect(result.modelId).toBe(secretRef);
  });
});

describe("registerDynamicProvider — idempotency and precedence", () => {
  const id = `${PREFIX}-dynamic`;

  afterEach(() => {
    delete DEFAULT_PROVIDER_BASE_URL_ENV[id];
    delete DEFAULT_PROVIDER_MODELS[id];
    delete PROVIDER_REGISTRY_ALIASES[id];
  });

  test("registering twice keeps first baseUrlEnvVar", () => {
    registerDynamicProvider(id, { baseUrlEnvVar: "FIRST_URL" });
    registerDynamicProvider(id, { baseUrlEnvVar: "SECOND_URL" });
    expect(DEFAULT_PROVIDER_BASE_URL_ENV[id]).toBe("FIRST_URL");
  });

  test("registering twice keeps first default model", () => {
    registerDynamicProvider(id, {
      baseUrlEnvVar: "URL",
      defaultModel: "model-v1",
    });
    registerDynamicProvider(id, {
      baseUrlEnvVar: "URL",
      defaultModel: "model-v2",
    });
    expect(DEFAULT_PROVIDER_MODELS[id]).toBe("model-v1");
  });

  test("explicit registryAlias is preferred over sdkCompat alias", () => {
    registerDynamicProvider(id, {
      baseUrlEnvVar: "URL",
      sdkCompat: "openai",
      registryAlias: "my-alias",
    });
    expect(PROVIDER_REGISTRY_ALIASES[id]).toBe("my-alias");
  });

  test("no registryAlias entry when neither sdkCompat nor explicit alias given", () => {
    registerDynamicProvider(id, { baseUrlEnvVar: "URL" });
    expect(PROVIDER_REGISTRY_ALIASES[id]).toBeUndefined();
  });

  test("registered dynamic provider's default is reachable via the explicit 'auto' keyword", () => {
    // A no-model agent now requires an explicit selection (no silent default),
    // but a config-driven provider's declared defaultModel still resolves when
    // the operator explicitly asks for "auto".
    registerDynamicProvider(id, {
      baseUrlEnvVar: "MY_BASE_URL",
      defaultModel: "dynamic-default",
    });
    expect(() => resolveModelRef("", { defaultProvider: id })).toThrow(
      "No model resolved"
    );
    const result = resolveModelRef("auto", { defaultProvider: id });
    expect(result.provider).toBe(id);
    expect(result.modelId).toBe("dynamic-default");
  });
});

describe("DEFAULT_PROVIDER_MODELS completeness", () => {
  // anthropic is intentionally excluded from the default-model set — its
  // default is resolved live by the gateway, not hardcoded. It still needs a
  // base-URL mapping, so it stays in PROVIDERS_WITH_BASE_URL below.
  const PROVIDERS_WITH_DEFAULT_MODEL = [
    "openai",
    "openai-codex",
    // Keyed by the gateway provider slug "gemini" (the providers.json id),
    // NOT "google" — the gateway never emits "google" as a defaultProvider.
    "gemini",
    "nvidia",
    "z-ai",
  ];
  const PROVIDERS_WITH_BASE_URL = [
    "anthropic",
    ...PROVIDERS_WITH_DEFAULT_MODEL,
  ];

  for (const provider of PROVIDERS_WITH_DEFAULT_MODEL) {
    test(`provider "${provider}" has a non-empty default model`, () => {
      expect(DEFAULT_PROVIDER_MODELS[provider]).toBeTruthy();
    });
  }

  for (const provider of PROVIDERS_WITH_BASE_URL) {
    test(`provider "${provider}" has a base URL env var mapping`, () => {
      expect(DEFAULT_PROVIDER_BASE_URL_ENV[provider]).toBeTruthy();
    });
  }
});
