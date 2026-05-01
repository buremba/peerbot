import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PROVIDER_BASE_URL_ENV,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "../openclaw/model-resolver";

describe("resolveModelRef", () => {
  let originalDefaultModel: string | undefined;
  let originalDefaultProvider: string | undefined;

  beforeEach(() => {
    originalDefaultModel = process.env.AGENT_DEFAULT_MODEL;
    originalDefaultProvider = process.env.AGENT_DEFAULT_PROVIDER;
    delete process.env.AGENT_DEFAULT_MODEL;
    delete process.env.AGENT_DEFAULT_PROVIDER;
  });

  afterEach(() => {
    if (originalDefaultModel !== undefined)
      process.env.AGENT_DEFAULT_MODEL = originalDefaultModel;
    else delete process.env.AGENT_DEFAULT_MODEL;
    if (originalDefaultProvider !== undefined)
      process.env.AGENT_DEFAULT_PROVIDER = originalDefaultProvider;
    else delete process.env.AGENT_DEFAULT_PROVIDER;
  });

  test("parses provider/model format", () => {
    const result = resolveModelRef("anthropic/claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("handles model with slashes (e.g. provider/org/model)", () => {
    const result = resolveModelRef("openai/gpt-4.1");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4.1");
  });

  test("resolves 'auto' to provider default model", () => {
    const result = resolveModelRef("anthropic/auto");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS.anthropic);
  });

  test("uses AGENT_DEFAULT_PROVIDER for bare model ID", () => {
    process.env.AGENT_DEFAULT_PROVIDER = "openai";
    const result = resolveModelRef("gpt-4.1");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4.1");
  });

  test("falls back to AGENT_DEFAULT_MODEL when rawModelRef is empty", () => {
    process.env.AGENT_DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
    const result = resolveModelRef("");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("falls back to provider default when no model or AGENT_DEFAULT_MODEL", () => {
    process.env.AGENT_DEFAULT_PROVIDER = "google";
    const result = resolveModelRef("");
    expect(result.provider).toBe("google");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS.google);
  });

  test("throws when no model can be determined", () => {
    expect(() => resolveModelRef("")).toThrow("No model configured");
  });

  test("throws when bare model ID and no default provider", () => {
    expect(() => resolveModelRef("some-model")).toThrow(
      'No provider specified for model "some-model"'
    );
  });

  test("trims whitespace from rawModelRef", () => {
    const result = resolveModelRef("  anthropic/claude-sonnet-4-20250514  ");
    expect(result.provider).toBe("anthropic");
  });
});

describe("registerDynamicProvider", () => {
  const testProviderId = `test-provider-${Date.now()}`;

  afterEach(() => {
    // Clean up test provider entries
    delete DEFAULT_PROVIDER_BASE_URL_ENV[testProviderId];
    delete DEFAULT_PROVIDER_MODELS[testProviderId];
    delete PROVIDER_REGISTRY_ALIASES[testProviderId];
  });

  test("registers new provider with baseUrlEnvVar", () => {
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "TEST_BASE_URL",
      sdkCompat: "openai",
    });
    expect(DEFAULT_PROVIDER_BASE_URL_ENV[testProviderId]).toBe("TEST_BASE_URL");
  });

  test("registers default model when provided", () => {
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "TEST_BASE_URL",
      defaultModel: "test-model-v1",
    });
    expect(DEFAULT_PROVIDER_MODELS[testProviderId]).toBe("test-model-v1");
  });

  test("sets registry alias for openai-compatible providers", () => {
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "TEST_BASE_URL",
      sdkCompat: "openai",
    });
    expect(PROVIDER_REGISTRY_ALIASES[testProviderId]).toBe("openai");
  });

  test("uses explicit registryAlias over sdkCompat", () => {
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "TEST_BASE_URL",
      sdkCompat: "openai",
      registryAlias: "custom",
    });
    expect(PROVIDER_REGISTRY_ALIASES[testProviderId]).toBe("custom");
  });

  test("skips already-registered provider", () => {
    DEFAULT_PROVIDER_BASE_URL_ENV[testProviderId] = "EXISTING";
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "NEW_VALUE",
    });
    expect(DEFAULT_PROVIDER_BASE_URL_ENV[testProviderId]).toBe("EXISTING");
  });

  test("does not set alias when no sdkCompat or registryAlias", () => {
    registerDynamicProvider(testProviderId, {
      baseUrlEnvVar: "TEST_BASE_URL",
    });
    expect(PROVIDER_REGISTRY_ALIASES[testProviderId]).toBeUndefined();
  });
});

describe("DEFAULT_PROVIDER_MODELS", () => {
  test("contains expected providers", () => {
    expect(DEFAULT_PROVIDER_MODELS.anthropic).toBeDefined();
    expect(DEFAULT_PROVIDER_MODELS.openai).toBeDefined();
    expect(DEFAULT_PROVIDER_MODELS.google).toBeDefined();
  });
});

describe("DEFAULT_PROVIDER_BASE_URL_ENV", () => {
  test("maps anthropic to ANTHROPIC_BASE_URL", () => {
    expect(DEFAULT_PROVIDER_BASE_URL_ENV.anthropic).toBe("ANTHROPIC_BASE_URL");
  });
});
