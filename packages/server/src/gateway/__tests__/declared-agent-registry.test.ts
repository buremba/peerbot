import { afterEach, describe, expect, test } from "bun:test";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import {
  buildRegistryMap,
  DeclaredAgentRegistry,
  entryFromAgentConfig,
} from "../services/declared-agent-registry.js";

function clearRegistry(): void {
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

/** Register a real config-driven module so its catalog defaultModel resolves. */
function registerApiKeyModule(providerId: string, defaultModel: string): void {
  moduleRegistry.register(
    new ApiKeyProviderModule({
      providerId,
      slug: providerId,
      sdkCompat: "openai",
      upstreamBaseUrl: `https://${providerId}.example.com/v1`,
      defaultModel,
      envVarName: `${providerId.toUpperCase()}_API_KEY`,
      providerDisplayName: providerId,
      providerIconUrl: "",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
      authProfilesManager: { getBestProfile: async () => null } as never,
    }) as unknown as ModuleInterface
  );
}

describe("DeclaredAgentRegistry", () => {
  test("starts empty", () => {
    const registry = new DeclaredAgentRegistry();
    expect(registry.agentIds()).toEqual([]);
    expect(registry.has("anything")).toBe(false);
    expect(registry.get("anything")).toBeUndefined();
  });

  test("replaceAll wipes prior entries", () => {
    const registry = new DeclaredAgentRegistry();
    registry.replaceAll(new Map([["a", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(true);

    registry.replaceAll(new Map([["b", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });
});

describe("entryFromAgentConfig", () => {
  afterEach(() => clearRegistry());

  test("expands providers into an ordered concrete models list + credentials", () => {
    const entry = entryFromAgentConfig({
      id: "agent-1",
      name: "Agent 1",
      providers: [
        { id: "openai", model: "gpt-4o", key: "sk-1" },
        { id: "anthropic", model: "anthropic/claude-sonnet-5", secretRef: "vault://anth" },
      ],
      network: { allowed: ["github.com"] },
      nixPackages: ["jq"],
    } as any);

    // Bare declared models get slug-prefixed; already-prefixed refs pass through.
    expect(entry.settings.models).toEqual([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-5",
    ]);
    expect(entry.settings.networkConfig).toEqual({
      allowedDomains: ["github.com"],
      deniedDomains: undefined,
    });
    expect(entry.settings.nixConfig).toEqual({ packages: ["jq"] });
    expect(entry.credentials).toEqual([
      { provider: "openai", key: "sk-1" },
      { provider: "anthropic", secretRef: "vault://anth" },
    ]);
  });

  test("resolves a provider with no declared model to its catalog defaultModel (never auto)", () => {
    registerApiKeyModule("acme", "acme-large-1");
    const entry = entryFromAgentConfig({
      id: "agent-2",
      name: "Agent 2",
      providers: [{ id: "acme" }, { id: "openai", model: "gpt-4o" }],
    } as any);

    // The primary keeps its position with a CONCRETE ref from the catalog.
    expect(entry.settings.models).toEqual(["acme/acme-large-1", "openai/gpt-4o"]);
  });

  test("#3(b): a provider with no model + no catalog default becomes a restriction sentinel (NOT dropped)", () => {
    const entry = entryFromAgentConfig({
      id: "agent-3",
      name: "Agent 3",
      providers: [{ id: "unknown-provider" }, { id: "openai", model: "gpt-4o" }],
    } as any);

    // The unresolvable provider is kept as a sentinel so the agent stays
    // RESTRICTED (gated), never dropped to allow-all.
    expect(entry.settings.models).toEqual([
      "unknown-provider/__unresolved__",
      "openai/gpt-4o",
    ]);
  });

  test("#3(b): an agent whose ONLY provider is unresolvable is restricted, not allow-all", () => {
    const entry = entryFromAgentConfig({
      id: "agent-4",
      name: "Agent 4",
      providers: [{ id: "unknown-provider" }],
    } as any);

    // A declared-provider agent must NEVER end with models undefined (= allow-all).
    expect(entry.settings.models).toEqual(["unknown-provider/__unresolved__"]);
    expect(entry.settings.models).not.toBeUndefined();
  });
});

describe("buildRegistryMap", () => {
  test("populates entries from SDK config agents", () => {
    const map = buildRegistryMap([
      {
        id: "agent-a",
        name: "Agent A",
        providers: [{ id: "openai", model: "gpt-4o", key: "sk-1" }],
      } as any,
      {
        id: "agent-b",
        name: "Agent B",
        providers: [{ id: "anthropic", model: "claude-sonnet-5", key: "sk-2" }],
      } as any,
    ]);

    expect(map.size).toBe(2);
    expect(map.get("agent-a")?.credentials).toEqual([
      { provider: "openai", key: "sk-1" },
    ]);
    expect(map.get("agent-b")?.credentials).toEqual([
      { provider: "anthropic", key: "sk-2" },
    ]);
  });
});
