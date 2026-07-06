import { afterEach, describe, expect, test } from "bun:test";
import {
  buildDynamicOpenAIModel,
  DEFAULT_PROVIDER_BASE_URL_ENV,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "../openclaw/model-resolver";

describe("resolveModelRef", () => {
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
    const result = resolveModelRef("openai/auto");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS.openai);
  });

  test("anthropic 'auto' is left as-is (no worker-side default to resolve)", () => {
    // anthropic has no worker-side default model, so the explicit "auto"
    // keyword passes through unchanged. In production a concrete Anthropic
    // model must be selected (no silent default).
    const result = resolveModelRef("anthropic/auto");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("auto");
  });

  test("uses overrides.defaultProvider for bare model ID", () => {
    const result = resolveModelRef("gpt-4.1", { defaultProvider: "openai" });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4.1");
  });

  test("strips the LOBU slug prefix when it differs from the upstream defaultProvider", () => {
    // The builder bug: model stored as "claude/…" but the worker is told the
    // upstream slug "anthropic". Without defaultProviderSlug the "claude/"
    // prefix survived and 404'd at the Anthropic API.
    const result = resolveModelRef("claude/claude-opus-4-8", {
      defaultProvider: "anthropic",
      defaultProviderSlug: "claude",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-opus-4-8");
  });

  test("still strips the upstream-slug prefix when the model uses it directly", () => {
    const result = resolveModelRef("anthropic/claude-opus-4-8", {
      defaultProvider: "anthropic",
      defaultProviderSlug: "claude",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-opus-4-8");
  });

  test("leaves a foreign-namespace model intact (does not strip a non-matching slug)", () => {
    // OpenRouter's "anthropic/claude-sonnet-4" is the provider's own model id,
    // not a Lobu prefix — it must pass through unchanged.
    const result = resolveModelRef("anthropic/claude-sonnet-4", {
      defaultProvider: "openrouter",
      defaultProviderSlug: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("behavior override switches to another installed provider", () => {
    const result = resolveModelRef("z-ai/glm-5.2", {
      defaultModel: "claude/claude-sonnet-4-5",
      defaultProvider: "anthropic",
      defaultProviderSlug: "claude",
      installedProviderRoutes: { claude: "anthropic", "z-ai": "z-ai" },
      allowInstalledProviderOverride: true,
    });

    expect(result.provider).toBe("z-ai");
    expect(result.modelId).toBe("glm-5.2");
  });

  test("behavior override resolves auto against the selected installed provider", () => {
    const result = resolveModelRef("z-ai/auto", {
      defaultModel: "claude/claude-sonnet-4-5",
      defaultProvider: "anthropic",
      defaultProviderSlug: "claude",
      installedProviderRoutes: { claude: "anthropic", "z-ai": "z-ai" },
      allowInstalledProviderOverride: true,
    });

    expect(result.provider).toBe("z-ai");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS["z-ai"]);
  });

  test("behavior override routes a Lobu provider ID to its upstream runtime slug", () => {
    const result = resolveModelRef("claude/claude-sonnet-4-5", {
      defaultModel: "z-ai/glm-5.2",
      defaultProvider: "z-ai",
      installedProviderRoutes: { claude: "anthropic", "z-ai": "z-ai" },
      allowInstalledProviderOverride: true,
    });

    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5");
  });

  test("falls back to overrides.defaultModel when rawModelRef is empty", () => {
    const result = resolveModelRef("", {
      defaultModel: "anthropic/claude-sonnet-4-20250514",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("no silent default: empty model with a provider now requires explicit selection", () => {
    // Lobu no longer silently substitutes the provider's default model — a
    // concrete model must be configured (chosen via the model picker).
    expect(() => resolveModelRef("", { defaultProvider: "gemini" })).toThrow(
      "No model resolved"
    );
  });

  test("throws when no model can be determined", () => {
    expect(() => resolveModelRef("")).toThrow("No model resolved");
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

  test("configured provider wins: OpenRouter vendor/model slug is passed through verbatim", () => {
    // Smoke case — the full matrix of configured-provider slug routing lives in
    // model-resolver-harden.test.ts. OpenRouter expresses models as
    // "vendor/model" in its OWN namespace; with a provider configured, do NOT
    // split — route to the configured provider and keep the model intact.
    const result = resolveModelRef("anthropic/claude-sonnet-4", {
      defaultProvider: "openrouter",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("installed providers do not reinterpret an OpenRouter vendor namespace", () => {
    const result = resolveModelRef("anthropic/claude-sonnet-4", {
      defaultProvider: "openrouter",
      installedProviderRoutes: { openrouter: "openrouter", "z-ai": "z-ai" },
    });

    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("base model stays on OpenRouter when its vendor prefix is also an installed provider", () => {
    const result = resolveModelRef("openai/gpt-4o", {
      defaultModel: "openai/gpt-4o",
      defaultProvider: "openrouter",
      installedProviderRoutes: { openrouter: "openrouter", openai: "openai" },
    });

    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o");
  });

  test("OpenRouter vendor model changes do not switch providers without an explicit behavior signal", () => {
    const result = resolveModelRef("openai/gpt-4o-mini", {
      defaultModel: "openai/gpt-4o",
      defaultProvider: "openrouter",
      installedProviderRoutes: { openrouter: "openrouter", openai: "openai" },
    });

    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o-mini");
  });

  test("configured provider: a redundant self-prefix is stripped (z-ai/glm-4.7 → glm-4.7)", () => {
    // Lobu names models "provider/model", but the upstream namespace is the
    // bare code. Sending "z-ai/glm-4.7" to z.ai 400s "Unknown Model" — strip
    // the configured provider's OWN id so the API receives "glm-4.7".
    const result = resolveModelRef("z-ai/glm-4.7", { defaultProvider: "z-ai" });
    expect(result.provider).toBe("z-ai");
    expect(result.modelId).toBe("glm-4.7");
  });

  test("configured provider: 'auto' resolving to a PREFIXED default is also stripped (nvidia)", () => {
    // The gap behind the first prefix fix: DEFAULT_PROVIDER_MODELS.nvidia is
    // itself prefixed ("nvidia/moonshotai/kimi-k2.5"). Stripping must run AFTER
    // auto-resolution, or an auto agent on nvidia ships the redundant prefix.
    const result = resolveModelRef("auto", { defaultProvider: "nvidia" });
    expect(result.provider).toBe("nvidia");
    expect(result.modelId).toBe(
      DEFAULT_PROVIDER_MODELS.nvidia.replace(/^nvidia\//, "")
    );
    expect(result.modelId.startsWith("nvidia/")).toBe(false);
  });

  test("configured provider: a bare model code is left untouched", () => {
    const result = resolveModelRef("glm-4.7", { defaultProvider: "z-ai" });
    expect(result.provider).toBe("z-ai");
    expect(result.modelId).toBe("glm-4.7");
  });

  test("configured provider + 'auto' resolves to that provider's default model", () => {
    const result = resolveModelRef("auto", { defaultProvider: "openai" });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe(DEFAULT_PROVIDER_MODELS.openai);
  });

  test("auto-mode (no configured provider) still derives provider from slug", () => {
    const result = resolveModelRef("groq/llama-x");
    expect(result.provider).toBe("groq");
    expect(result.modelId).toBe("llama-x");
  });
});

describe("DEFAULT_PROVIDER_BASE_URL_ENV — no shared base-URL key", () => {
  // Worker-side half of the codex collision fix. The OpenAI SDK base URL for
  // `openai` is read from OPENAI_BASE_URL; the Codex (openai-codex) backend MUST
  // read its own key, else a clobbered OPENAI_BASE_URL routes openai/<model> to
  // chatgpt.com/backend-api (the original 403). Pin the exact key + disjointness
  // so a regression back to OPENAI_BASE_URL fails here, not just at runtime.
  test("openai-codex uses OPENAI_CODEX_BASE_URL, distinct from openai", () => {
    expect(DEFAULT_PROVIDER_BASE_URL_ENV["openai-codex"]).toBe(
      "OPENAI_CODEX_BASE_URL"
    );
    expect(DEFAULT_PROVIDER_BASE_URL_ENV.openai).toBe("OPENAI_BASE_URL");
    expect(DEFAULT_PROVIDER_BASE_URL_ENV["openai-codex"]).not.toBe(
      DEFAULT_PROVIDER_BASE_URL_ENV.openai
    );
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
    // anthropic is intentionally absent — its default is resolved live by the
    // gateway (newest model), never hardcoded here.
    expect(DEFAULT_PROVIDER_MODELS.anthropic).toBeUndefined();
    expect(DEFAULT_PROVIDER_MODELS.openai).toBeDefined();
    // Keyed by gateway slug "gemini" (the config provider id), not "google".
    expect(DEFAULT_PROVIDER_MODELS.gemini).toBeDefined();
  });
});

describe("buildDynamicOpenAIModel — never silently route to OpenAI", () => {
  test("third-party provider with a resolved base URL builds an entry", () => {
    const model = buildDynamicOpenAIModel({
      rawProvider: "gemini",
      registryProvider: "openai",
      modelId: "gemini-2.5-flash",
      providerBaseUrl: "http://localhost:8118/api/proxy/gemini/a/agent-1",
    });
    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("gemini-2.5-flash");
    expect(model.provider).toBe("openai");
    expect(model.baseUrl).toBe(
      "http://localhost:8118/api/proxy/gemini/a/agent-1"
    );
  });

  test("uses the passed pi-ai api for non-openai protocols (generic)", () => {
    const model = buildDynamicOpenAIModel({
      rawProvider: "my-claude",
      registryProvider: "anthropic",
      modelId: "claude-opus-4-8",
      providerBaseUrl: "http://localhost:8118/api/proxy/my-claude/a/agent-1",
      api: "anthropic-messages",
    });
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-opus-4-8");
  });

  test("defaults to openai-completions when no api is passed", () => {
    const model = buildDynamicOpenAIModel({
      rawProvider: "groq",
      registryProvider: "openai",
      modelId: "llama-3.3-70b",
      providerBaseUrl: "http://localhost:8118/api/proxy/groq/a/agent-1",
    });
    expect(model.api).toBe("openai-completions");
  });

  test("THROWS for a third-party provider with no resolved base URL", () => {
    // Regression for the silent-misroute bug: an unresolved proxy base URL
    // previously fell back to api.openai.com, shipping the request to OpenAI
    // with an unknown model ID ("400 <model> is not a valid model ID").
    expect(() =>
      buildDynamicOpenAIModel({
        rawProvider: "gemini",
        registryProvider: "openai",
        modelId: "gemini-2.5-flash",
        providerBaseUrl: undefined,
      })
    ).toThrow(/gateway routing URL.*GEMINI_API_BASE_URL/);
  });

  test("THROWS for nvidia/together/etc with no base URL (generic, all providers)", () => {
    for (const rawProvider of ["nvidia", "together-ai", "z-ai", "groq"]) {
      expect(() =>
        buildDynamicOpenAIModel({
          rawProvider,
          registryProvider: "openai",
          modelId: "some-model",
          providerBaseUrl: undefined,
        })
      ).toThrow(/Connect the provider in the agent's Providers settings/);
    }
  });

  test("real OpenAI MAY default to api.openai.com when base URL is absent", () => {
    const model = buildDynamicOpenAIModel({
      rawProvider: "openai",
      registryProvider: "openai",
      modelId: "gpt-4.1",
      providerBaseUrl: undefined,
    });
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
  });
});

describe("DEFAULT_PROVIDER_BASE_URL_ENV — gateway-slug keying", () => {
  test("gemini base-URL env is keyed by the 'gemini' slug, not 'google'", () => {
    // The gateway emits the provider slug "gemini" (config id) as
    // defaultProvider and keys its proxy mapping on GEMINI_API_BASE_URL.
    // The worker's fallback map MUST use the same "gemini" key, or
    // providerBaseUrl resolution misses and the request silently routes to
    // OpenAI. A dead "google" key would never match.
    expect(DEFAULT_PROVIDER_BASE_URL_ENV.gemini).toBe("GEMINI_API_BASE_URL");
    expect(DEFAULT_PROVIDER_BASE_URL_ENV.google).toBeUndefined();
  });
});

describe("DEFAULT_PROVIDER_BASE_URL_ENV", () => {
  test("maps anthropic to ANTHROPIC_BASE_URL", () => {
    expect(DEFAULT_PROVIDER_BASE_URL_ENV.anthropic).toBe("ANTHROPIC_BASE_URL");
  });
});
