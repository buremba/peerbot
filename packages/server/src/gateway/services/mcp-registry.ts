import { createLogger } from "@lobu/core";
import type { ProviderConfigResolver } from "./provider-config-resolver.js";

const logger = createLogger("mcp-registry");

/**
 * MCP server entry from the registry
 */
interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  type: "oauth" | "stdio" | "sse" | "api-key";
  config: Record<string, unknown>;
  setupInstructions?: string;
}

/**
 * Service for accessing the MCP server registry.
 */
export class McpRegistryService {
  /**
   * Curated list of popular MCPs for quick-add chips in the settings UI.
   */
  static readonly CURATED_MCP_IDS = [
    "sentry",
    "playwright",
    "github",
    "notion",
    "linear",
  ];

  private registry: McpRegistryEntry[] = [];
  private loaded = false;

  constructor(private readonly resolver?: ProviderConfigResolver) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    if (!this.resolver) {
      logger.warn("MCP registry resolver not configured");
      return;
    }

    const resolved = await this.resolver.getMcpRegistryServers();
    this.registry = resolved.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      config: entry.config,
    }));

    logger.info(`Loaded ${this.registry.length} MCPs from resolver`);
  }

  async getCurated(): Promise<McpRegistryEntry[]> {
    await this.ensureLoaded();

    const curated = this.registry.filter((mcp) =>
      McpRegistryService.CURATED_MCP_IDS.includes(mcp.id)
    );

    return curated.length > 0 ? curated : this.registry.slice(0, 5);
  }

  async search(query: string, limit = 20): Promise<McpRegistryEntry[]> {
    await this.ensureLoaded();

    const trimmed = query.toLowerCase().trim();
    if (!trimmed) return this.registry.slice(0, limit);

    return this.registry
      .filter(
        (entry) =>
          entry.name.toLowerCase().includes(trimmed) ||
          entry.description.toLowerCase().includes(trimmed) ||
          entry.id.toLowerCase().includes(trimmed)
      )
      .slice(0, limit);
  }

  async getAll(): Promise<McpRegistryEntry[]> {
    await this.ensureLoaded();
    return this.registry;
  }

  async getById(id: string): Promise<McpRegistryEntry | null> {
    await this.ensureLoaded();
    return this.registry.find((entry) => entry.id === id) || null;
  }
}
