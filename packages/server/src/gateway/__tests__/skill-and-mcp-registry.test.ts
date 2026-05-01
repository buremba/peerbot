import { describe, expect, test } from "bun:test";
import { McpRegistryService } from "../services/mcp-registry.js";
import type { ProviderConfigResolver } from "../services/provider-config-resolver.js";

// --- McpRegistryService ---

function createMockResolver(
  entries: Array<{
    id: string;
    name: string;
    description: string;
    type: "oauth" | "stdio" | "sse" | "api-key";
    config: Record<string, unknown>;
  }>
) {
  return {
    getMcpRegistryServers: async () => entries,
  } as unknown as ProviderConfigResolver;
}

const mcpEntries = [
  {
    id: "github",
    name: "GitHub",
    description: "GitHub integration",
    type: "stdio" as const,
    config: { type: "stdio" },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Error tracking",
    type: "sse" as const,
    config: { type: "sse" },
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Browser automation",
    type: "stdio" as const,
    config: {},
  },
  {
    id: "notion",
    name: "Notion",
    description: "Notion workspace",
    type: "oauth" as const,
    config: {},
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issue tracker",
    type: "api-key" as const,
    config: {},
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack messaging",
    type: "oauth" as const,
    config: {},
  },
  {
    id: "jira",
    name: "Jira",
    description: "Project management",
    type: "api-key" as const,
    config: {},
  },
];

describe("McpRegistryService", () => {
  test("getCurated returns entries matching curated IDs", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));
    const curated = await service.getCurated();

    const ids = curated.map((e) => e.id);
    for (const curatedId of McpRegistryService.CURATED_MCP_IDS) {
      expect(ids).toContain(curatedId);
    }
    expect(curated).toHaveLength(5);
  });

  test("getCurated falls back to first 5 when no curated IDs match", async () => {
    const noCuratedEntries = [
      {
        id: "custom1",
        name: "Custom 1",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
      {
        id: "custom2",
        name: "Custom 2",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
      {
        id: "custom3",
        name: "Custom 3",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
      {
        id: "custom4",
        name: "Custom 4",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
      {
        id: "custom5",
        name: "Custom 5",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
      {
        id: "custom6",
        name: "Custom 6",
        description: "Desc",
        type: "sse" as const,
        config: {},
      },
    ];
    const service = new McpRegistryService(
      createMockResolver(noCuratedEntries)
    );
    const curated = await service.getCurated();

    expect(curated).toHaveLength(5);
    expect(curated.map((e) => e.id)).toEqual([
      "custom1",
      "custom2",
      "custom3",
      "custom4",
      "custom5",
    ]);
  });

  test("search matches by name, description, and id", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));

    const byName = await service.search("GitHub");
    expect(byName.some((e) => e.id === "github")).toBe(true);

    const byDesc = await service.search("Browser automation");
    expect(byDesc.some((e) => e.id === "playwright")).toBe(true);

    const byId = await service.search("linear");
    expect(byId.some((e) => e.id === "linear")).toBe(true);
  });

  test("search respects limit", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));
    // "a" appears in many names/descriptions
    const results = await service.search("a", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("search with empty query returns all up to limit", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));

    const results = await service.search("", 3);
    expect(results).toHaveLength(3);

    const allResults = await service.search("");
    expect(allResults).toHaveLength(mcpEntries.length);
  });

  test("getAll returns complete list", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));
    const all = await service.getAll();
    expect(all).toHaveLength(mcpEntries.length);
  });

  test("getById returns specific entry", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));

    const entry = await service.getById("sentry");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("Sentry");
  });

  test("getById returns null for unknown id", async () => {
    const service = new McpRegistryService(createMockResolver(mcpEntries));
    const entry = await service.getById("nonexistent");
    expect(entry).toBeNull();
  });

  test("no resolver returns empty results", async () => {
    const service = new McpRegistryService();

    expect(await service.getCurated()).toEqual([]);
    expect(await service.search("github")).toEqual([]);
    expect(await service.getAll()).toEqual([]);
    expect(await service.getById("github")).toBeNull();
  });
});
