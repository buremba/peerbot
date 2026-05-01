import type { ProviderConfigEntry } from "@lobu/core";
import type { ProviderRegistryService } from "./provider-registry-service.js";

interface ResolvedMcpRegistryServer {
  id: string;
  name: string;
  description: string;
  type: "oauth" | "stdio" | "sse" | "api-key";
  config: Record<string, unknown>;
}

export class ProviderConfigResolver {
  constructor(
    private readonly providerRegistryService: ProviderRegistryService
  ) {}

  async getProviderConfigs(): Promise<Record<string, ProviderConfigEntry>> {
    return this.providerRegistryService.getProviderConfigs();
  }

  async getGlobalMcpServers(): Promise<
    Record<string, Record<string, unknown>>
  > {
    return {};
  }

  async getMcpRegistryServers(): Promise<ResolvedMcpRegistryServer[]> {
    return [];
  }
}
