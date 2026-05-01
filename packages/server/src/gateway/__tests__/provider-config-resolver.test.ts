import { describe, expect, test } from "bun:test";
import type { ProviderConfigEntry, ProviderRegistryEntry } from "@lobu/core";
import { ProviderConfigResolver } from "../services/provider-config-resolver.js";

class MockProviderRegistryService {
  constructor(
    private readonly providers: Record<string, ProviderConfigEntry>
  ) {}

  async getProviderConfigs(): Promise<Record<string, ProviderConfigEntry>> {
    return this.providers;
  }

  async getRawProviderEntries(): Promise<ProviderRegistryEntry[]> {
    return [];
  }
}

describe("ProviderConfigResolver", () => {
  test("returns provider configs and no bundled MCP servers", async () => {
    const resolver = new ProviderConfigResolver(
      new MockProviderRegistryService({
        groq: {
          displayName: "Groq",
          iconUrl: "https://example.com/groq.png",
          envVarName: "GROQ_API_KEY",
          upstreamBaseUrl: "https://api.groq.com/openai",
          apiKeyInstructions: "Get key",
          apiKeyPlaceholder: "gsk_...",
        },
      }) as any
    );

    expect(await resolver.getGlobalMcpServers()).toEqual({});
    expect(await resolver.getMcpRegistryServers()).toEqual([]);
    expect(Object.keys(await resolver.getProviderConfigs())).toEqual(["groq"]);
  });
});
