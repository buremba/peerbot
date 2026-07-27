import { beforeEach, describe, expect, test } from "bun:test";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import type { ProviderConfigEntry } from "@lobu/core";
import { buildProviderCatalog } from "../provider-catalog.js";

/**
 * buildProviderCatalog is the single source both the org inference-providers
 * catalog route and the per-agent agent-config catalog map from. It must:
 *  - include OAuth modules (Claude/ChatGPT) with their auth metadata, so they
 *    appear in the "Add provider" catalog;
 *  - carry sdkCompat so the POST route can gate on routable protocols via
 *    isSdkCompat (openai, anthropic, google, …) — not only "openai". OAuth /
 *    subscription-only providers carry a null sdkCompat ⇒ rejected.
 *
 * The registry is a process-global singleton; these tests register minimal fake
 * modules and clear between cases to stay hermetic.
 */

function fakeModule(
  overrides: Partial<Record<string, unknown>> & { providerId: string }
): ModuleInterface {
  return {
    // Registry keys modules by `name` and only stores enabled ones.
    name: `${overrides.providerId}-provider`,
    isEnabled: () => true,
    // Fields buildProviderCatalog reads off the module.
    providerDisplayName: overrides.providerId,
    providerIconUrl: "",
    authType: "api-key",
    // Marks it as a ModelProviderModule for getModelProviderModules()'s filter.
    getSecretEnvVarNames: () => [],
    ...overrides,
  } as unknown as ModuleInterface;
}

function clearRegistry(): void {
  // No public clear(); reset the internal Map between tests.
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

describe("buildProviderCatalog", () => {
  beforeEach(() => clearRegistry());

  test("OAuth modules appear with their auth metadata and null sdkCompat", () => {
    moduleRegistry.register(
      fakeModule({
        providerId: "claude",
        providerDisplayName: "Claude",
        authType: "oauth",
        supportedAuthTypes: ["oauth", "api-key"],
      })
    );

    const catalog = buildProviderCatalog();
    const claude = catalog.find((e) => e.slug === "claude");
    expect(claude).toBeDefined();
    expect(claude?.authType).toBe("oauth");
    expect(claude?.supportedAuthTypes).toEqual(["oauth", "api-key"]);
    // No providers.json enrichment and no module metadata ⇒ not addable by key.
    expect(claude?.sdkCompat).toBeNull();
  });

  test("config enrichment sets sdkCompat/modalities for api-key providers", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "groq", providerDisplayName: "Groq" })
    );
    const configs: Record<string, ProviderConfigEntry> = {
      groq: {
        displayName: "Groq",
        iconUrl: "https://icon/groq.png",
        envVarName: "GROQ_API_KEY",
        upstreamBaseUrl: "https://api.groq.com/openai/v1",
        apiKeyInstructions: "",
        apiKeyPlaceholder: "gsk_...",
        sdkCompat: "openai",
        modalities: ["text", "stt"],
        defaultModel: "llama-3.3-70b-versatile",
      },
    };

    const catalog = buildProviderCatalog(configs);
    const groq = catalog.find((e) => e.slug === "groq");
    expect(groq?.sdkCompat).toBe("openai");
    expect(groq?.modalities).toEqual(["text", "stt"]);
    expect(groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(groq?.defaultModel).toBe("llama-3.3-70b-versatile");
  });

  test("marks providers backed by a system credential as available", () => {
    moduleRegistry.register(
      fakeModule({
        providerId: "claude",
        providerDisplayName: "Claude",
        hasSystemKey: () => true,
      })
    );

    const claude = buildProviderCatalog().find((e) => e.slug === "claude");
    expect(claude?.systemAvailable).toBe(true);
  });

  /**
   * Models come from the build-time models.dev snapshot keyed by LOBU provider
   * id, NOT from a hand-maintained array. A curated list is exactly what went
   * stale silently — the shipped Claude list was missing a flagship released
   * days earlier and no gate caught it.
   */
  test("models come from the models.dev snapshot, newest release first", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "claude", providerDisplayName: "Claude" })
    );

    const claude = buildProviderCatalog().find((e) => e.slug === "claude");
    // The snapshot's current Anthropic flagship, which no hand-maintained list
    // in this repo contained — the staleness this replaces.
    expect(claude?.models).toContain("claude-opus-5");
    // Rich metadata rides alongside the bare ids, in the same order.
    expect(claude?.modelDetails.map((m) => m.id)).toEqual(claude?.models ?? []);
    // Sorted newest-first, so the picker's first entry is the current flagship.
    const dates = (claude?.modelDetails ?? [])
      .map((m) => m.releaseDate)
      .filter((d): d is string => !!d);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  /**
   * A deployment-level provider has no providers.json enrichment in the
   * agent-config call path (buildProviderCatalog is called with no configs),
   * but its models must still appear — otherwise a system-key provider shows an
   * empty picker.
   */
  test("snapshot models appear even with no providers.json enrichment", () => {
    moduleRegistry.register(
      fakeModule({
        providerId: "claude",
        providerDisplayName: "Claude",
        hasSystemKey: () => true,
      })
    );

    const claude = buildProviderCatalog().find((e) => e.slug === "claude");
    expect(claude?.systemAvailable).toBe(true);
    expect(claude?.models.length).toBeGreaterThan(0);
  });

  test("a provider absent from the snapshot degrades to an empty list", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "self-hosted-vllm" })
    );
    const entry = buildProviderCatalog().find(
      (e) => e.slug === "self-hosted-vllm"
    );
    expect(entry).toBeDefined();
    expect(entry?.models).toEqual([]);
    expect(entry?.modelDetails).toEqual([]);
    expect(entry?.modelsDevId).toBeNull();
  });

  test("supportedAuthTypes defaults to [authType] when absent", () => {
    moduleRegistry.register(fakeModule({ providerId: "cerebras" }));
    const catalog = buildProviderCatalog();
    const cerebras = catalog.find((e) => e.slug === "cerebras");
    expect(cerebras?.authType).toBe("api-key");
    expect(cerebras?.supportedAuthTypes).toEqual(["api-key"]);
    // No config ⇒ text-only default.
    expect(cerebras?.modalities).toEqual(["text"]);
  });

  test("catalogVisible === false hides a module", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "hidden", catalogVisible: false })
    );
    const catalog = buildProviderCatalog();
    expect(catalog.find((e) => e.slug === "hidden")).toBeUndefined();
  });

  test("entries are sorted by slug", () => {
    moduleRegistry.register(fakeModule({ providerId: "zebra" }));
    moduleRegistry.register(fakeModule({ providerId: "alpha" }));
    const slugs = buildProviderCatalog().map((e) => e.slug);
    expect(slugs).toEqual(["alpha", "zebra"]);
  });
});
