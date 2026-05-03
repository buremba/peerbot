import { describe, expect, test } from "bun:test";
import {
  buildRegistryMap,
  DeclaredAgentRegistry,
  entryFromAgentConfig,
} from "../services/declared-agent-registry.js";

describe("DeclaredAgentRegistry", () => {
  test("starts empty", () => {
    const registry = new DeclaredAgentRegistry();
    expect(registry.agentIds()).toEqual([]);
    expect(registry.has("anything")).toBe(false);
    expect(registry.get("anything")).toBeUndefined();
    expect(registry.findTemplateAgentId()).toBeNull();
  });

  test("replaceAll wipes prior entries", () => {
    const registry = new DeclaredAgentRegistry();
    registry.replaceAll(new Map([["a", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(true);

    registry.replaceAll(new Map([["b", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });

  test("findTemplateAgentId returns first agent with installed providers", () => {
    const registry = new DeclaredAgentRegistry();
    registry.replaceAll(
      new Map([
        ["bare", { settings: {}, credentials: [] }],
        [
          "with-providers",
          {
            settings: {
              installedProviders: [{ providerId: "openai", installedAt: 1 }],
            },
            credentials: [],
          },
        ],
      ])
    );
    expect(registry.findTemplateAgentId()).toBe("with-providers");
  });
});

describe("entryFromAgentConfig", () => {
  test("expands providers into installed list, credentials, and model preferences", () => {
    const entry = entryFromAgentConfig({
      id: "agent-1",
      name: "Agent 1",
      providers: [
        { id: "openai", model: "gpt-4o", key: "sk-1" },
        { id: "anthropic", secretRef: "vault://anth" },
      ],
      network: { allowed: ["github.com"] },
      nixPackages: ["jq"],
    } as any);

    expect(entry.settings.installedProviders).toEqual([
      { providerId: "openai", installedAt: expect.any(Number) },
      { providerId: "anthropic", installedAt: expect.any(Number) },
    ]);
    expect(entry.settings.providerModelPreferences).toEqual({
      openai: "gpt-4o",
    });
    expect(entry.settings.modelSelection).toEqual({ mode: "auto" });
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
});

describe("buildRegistryMap", () => {
  test("populates entries from SDK config agents", () => {
    const map = buildRegistryMap([
      {
        id: "agent-a",
        name: "Agent A",
        providers: [{ id: "openai", key: "sk-1" }],
      } as any,
      {
        id: "agent-b",
        name: "Agent B",
        providers: [{ id: "anthropic", key: "sk-2" }],
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
