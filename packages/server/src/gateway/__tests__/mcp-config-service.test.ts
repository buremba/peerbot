// Set ENCRYPTION_KEY before any imports that use encryption
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { McpConfigService } from "../auth/mcp/config-service.js";

function makeToken(agentId = "agent1") {
  return generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId,
  });
}

const BASE_URL = "http://localhost:8080/mcp";

describe("McpConfigService", () => {
  test("registerGlobalServers - HTTP + stdio", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "http-server": {
        url: "https://upstream.example.com/mcp",
        type: "sse",
      },
      "stdio-server": {
        command: "node",
        args: ["server.js"],
        type: "stdio",
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken(),
    });

    // HTTP server should be rewritten
    expect(config.mcpServers["http-server"]).toBeDefined();
    expect(config.mcpServers["http-server"].url).toBe(BASE_URL);
    expect(config.mcpServers["http-server"].type).toBe("sse");

    // Stdio server should be unchanged
    expect(config.mcpServers["stdio-server"]).toBeDefined();
    expect(config.mcpServers["stdio-server"].command).toBe("node");
    expect(config.mcpServers["stdio-server"].args).toEqual(["server.js"]);
    expect(config.mcpServers["stdio-server"].type).toBe("stdio");
  });

  test("registerGlobalServers - skip duplicates", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "my-mcp": { url: "https://first.example.com/mcp", type: "sse" },
    });
    service.registerGlobalServers({
      "my-mcp": { url: "https://second.example.com/mcp", type: "sse" },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken(),
    });

    // Only first registration should stick (url gets rewritten to baseUrl,
    // but the httpServer entry should reflect the first upstream)
    expect(config.mcpServers["my-mcp"]).toBeDefined();
    const servers = await service.getAllHttpServers();
    expect(servers.get("my-mcp")?.upstreamUrl).toBe(
      "https://first.example.com/mcp"
    );
  });

  test("getWorkerConfig - rewrites HTTP URLs", async () => {
    const service = new McpConfigService();
    const token = makeToken();
    service.registerGlobalServers({
      "test-mcp": { url: "https://upstream.example.com/mcp", type: "sse" },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: token,
    });

    const mcp = config.mcpServers["test-mcp"];
    expect(mcp.url).toBe(BASE_URL);
    expect(mcp.type).toBe("sse");
    expect(mcp.headers.Authorization).toBe(`Bearer ${token}`);
    expect(mcp.headers["X-Mcp-Id"]).toBe("test-mcp");
  });

  test("getWorkerConfig - preserves custom headers", async () => {
    const service = new McpConfigService();
    const token = makeToken();
    service.registerGlobalServers({
      "custom-mcp": {
        url: "https://upstream.example.com/mcp",
        type: "sse",
        headers: { "X-Custom": "value", "X-Another": "data" },
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: token,
    });

    const headers = config.mcpServers["custom-mcp"].headers;
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["X-Another"]).toBe("data");
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["X-Mcp-Id"]).toBe("custom-mcp");
  });

  test("getWorkerConfig - includes stdio without rewriting", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "stdio-mcp": {
        command: "python",
        args: ["-m", "mcp_server"],
        type: "stdio",
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken(),
    });

    const mcp = config.mcpServers["stdio-mcp"];
    expect(mcp.command).toBe("python");
    expect(mcp.args).toEqual(["-m", "mcp_server"]);
    expect(mcp.type).toBe("stdio");
    expect(mcp.headers).toBeUndefined();
  });

  test("getWorkerConfig - merges per-agent MCPs", async () => {
    const mockAgentSettingsStore = {
      getEffectiveSettings: async (agentId: string) => {
        if (agentId === "agent1") {
          return {
            mcpServers: {
              "agent-mcp": {
                url: "https://agent-mcp.example.com/mcp",
                type: "sse",
              },
            },
          };
        }
        return null;
      },
    };

    const service = new McpConfigService({
      agentSettingsStore: mockAgentSettingsStore as any,
    });
    service.registerGlobalServers({
      "global-mcp": { url: "https://global.example.com/mcp", type: "sse" },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken("agent1"),
    });

    expect(config.mcpServers["global-mcp"]).toBeDefined();
    expect(config.mcpServers["agent-mcp"]).toBeDefined();
    expect(config.mcpServers["agent-mcp"].url).toBe(BASE_URL);
    expect(config.mcpServers["agent-mcp"].perAgent).toBe(true);
  });

  test("getWorkerConfig - rejects invalid tokens", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "test-mcp": { url: "https://upstream.example.com/mcp", type: "sse" },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: "invalid-garbage-token",
    });

    expect(Object.keys(config.mcpServers)).toHaveLength(0);
  });

  test("getWorkerConfig - skips disabled MCPs", async () => {
    const mockAgentSettingsStore = {
      getEffectiveSettings: async () => ({
        mcpServers: {
          "disabled-mcp": {
            url: "https://disabled.example.com/mcp",
            type: "sse",
            enabled: false,
          },
          "enabled-mcp": {
            url: "https://enabled.example.com/mcp",
            type: "sse",
          },
        },
      }),
    };

    const service = new McpConfigService({
      agentSettingsStore: mockAgentSettingsStore as any,
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken("agent1"),
    });

    expect(config.mcpServers["disabled-mcp"]).toBeUndefined();
    expect(config.mcpServers["enabled-mcp"]).toBeDefined();
  });

  test("getWorkerConfig - per-agent takes precedence over global", async () => {
    const mockAgentSettingsStore = {
      getEffectiveSettings: async () => ({
        mcpServers: {
          "shared-mcp": {
            url: "https://agent-version.example.com/mcp",
            type: "sse",
          },
        },
      }),
    };

    const service = new McpConfigService({
      agentSettingsStore: mockAgentSettingsStore as any,
    });
    service.registerGlobalServers({
      "shared-mcp": {
        url: "https://global-version.example.com/mcp",
        type: "sse",
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken("agent1"),
    });

    expect(config.mcpServers["shared-mcp"]).toBeDefined();
    expect(config.mcpServers["shared-mcp"].perAgent).toBe(true);

    const servers = await service.getAllHttpServers("agent1");
    expect(servers.get("shared-mcp")?.upstreamUrl).toBe(
      "https://agent-version.example.com/mcp"
    );
  });

  test("getWorkerConfig - derives lobu-memory from agent organization", async () => {
    const service = new McpConfigService({
      agentSettingsStore: {
        getEffectiveSettings: async () => ({ mcpServers: {} }),
      } as any,
      lobuMemory: {
        publicBaseUrl: "https://app.lobu.ai",
        resolveOrgSlug: async (agentId) => (agentId === "agent1" ? "buremba" : null),
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: BASE_URL,
      workerToken: makeToken("agent1"),
    });

    expect(config.mcpServers["lobu-memory"]).toBeDefined();
    expect(config.mcpServers["lobu-memory"].url).toBe(BASE_URL);
    expect(config.mcpServers["lobu-memory"].headers["X-Mcp-Id"]).toBe(
      "lobu-memory"
    );
    expect(config.mcpServers["lobu-memory"].internal).toBe(true);

    const servers = await service.getAllHttpServers("agent1");
    const lobuMemoryServer = servers.get("lobu-memory");
    expect(lobuMemoryServer?.upstreamUrl).toBe(
      "https://app.lobu.ai/mcp/buremba"
    );
    expect(lobuMemoryServer?.internal).toBe(true);
  });

  test("getMcpStatus - returns correct auth and input flags", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "oauth-mcp": {
        url: "https://oauth.example.com/mcp",
        type: "sse",
        oauth: { clientId: "abc" },
      },
      "login-mcp": {
        url: "https://login.example.com/mcp",
        type: "sse",
        loginUrl: "https://login.example.com/auth", // backward compat: loginUrl → oauth: {}
      },
      "input-mcp": {
        url: "https://input.example.com/mcp",
        type: "sse",
        inputs: [
          { type: "promptString", id: "api_key", description: "API key" },
        ],
      },
      "plain-mcp": {
        url: "https://plain.example.com/mcp",
        type: "sse",
      },
    });

    const statuses = await service.getMcpStatus("agent1");

    const oauthStatus = statuses.find((s) => s.id === "oauth-mcp");
    expect(oauthStatus?.requiresAuth).toBe(true);
    expect(oauthStatus?.requiresInput).toBe(false);

    const loginStatus = statuses.find((s) => s.id === "login-mcp");
    expect(loginStatus?.requiresAuth).toBe(true);

    const inputStatus = statuses.find((s) => s.id === "input-mcp");
    expect(inputStatus?.requiresInput).toBe(true);
    expect(inputStatus?.requiresAuth).toBe(false);

    const plainStatus = statuses.find((s) => s.id === "plain-mcp");
    expect(plainStatus?.requiresAuth).toBe(false);
    expect(plainStatus?.requiresInput).toBe(false);
  });

  test("getAllHttpServers - merges global + per-agent, excludes disabled and non-HTTP", async () => {
    const mockAgentSettingsStore = {
      getEffectiveSettings: async () => ({
        mcpServers: {
          "agent-http": {
            url: "https://agent-http.example.com/mcp",
            type: "sse",
          },
          "agent-stdio": {
            command: "node",
            args: ["server.js"],
            type: "stdio",
          },
          "agent-disabled": {
            url: "https://disabled.example.com/mcp",
            type: "sse",
            enabled: false,
          },
        },
      }),
    };

    const service = new McpConfigService({
      agentSettingsStore: mockAgentSettingsStore as any,
    });
    service.registerGlobalServers({
      "global-http": { url: "https://global.example.com/mcp", type: "sse" },
    });

    const servers = await service.getAllHttpServers("agent1");

    expect(servers.has("global-http")).toBe(true);
    expect(servers.has("agent-http")).toBe(true);
    expect(servers.has("agent-stdio")).toBe(false);
    expect(servers.has("agent-disabled")).toBe(false);
  });

  test("getGlobalMcpServers - returns settings-compatible format", async () => {
    const service = new McpConfigService();
    service.registerGlobalServers({
      "http-mcp": { url: "https://example.com/mcp", type: "sse" },
      "stdio-mcp": { command: "node", args: ["s.js"], type: "stdio" },
    });

    const result = await service.getGlobalMcpServers();

    expect(result["http-mcp"]).toEqual({
      url: "https://example.com/mcp",
      type: "sse",
    });
    expect(result["stdio-mcp"]).toEqual({
      url: undefined,
      type: "stdio",
    });
  });
});
