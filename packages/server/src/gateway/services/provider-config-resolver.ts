import type { ProviderConfigEntry } from "@lobu/core";
import type { ProviderRegistryService } from "./provider-registry-service.js";

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
}
