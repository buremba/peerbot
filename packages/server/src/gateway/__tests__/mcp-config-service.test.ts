// Set ENCRYPTION_KEY before any imports that use encryption
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { afterEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { McpConfigService } from "../auth/mcp/config-service.js";

function makeToken(agentId = "agent1") {
  return generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId,
  });
}

const WORKER_MCP_URL = "http://localhost:8080/mcp";
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_DISPATCHER_URL = process.env.DISPATCHER_URL;

afterEach(() => {
  if (ORIGINAL_PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_PORT;
  }
  if (ORIGINAL_DISPATCHER_URL === undefined) {
    delete process.env.DISPATCHER_URL;
  } else {
    process.env.DISPATCHER_URL = ORIGINAL_DISPATCHER_URL;
  }
});

describe("McpConfigService", () => {
  test("returns no MCPs when lobu-memory cannot be derived", async () => {
    const service = new McpConfigService();

    const config = await service.getWorkerConfig({
      baseUrl: WORKER_MCP_URL,
      workerToken: makeToken(),
    });

    expect(config.mcpServers).toEqual({});
    expect(await service.getMcpStatus("agent1")).toEqual([]);
    expect(await service.getAllHttpServers("agent1")).toEqual(new Map());
  });

  test("derives only the system lobu-memory MCP for workers", async () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    const token = makeToken();
    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async (agentId) =>
          agentId === "agent1" ? "acme" : null,
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: WORKER_MCP_URL,
      workerToken: token,
    });

    expect(Object.keys(config.mcpServers)).toEqual(["lobu-memory"]);
    expect(config.mcpServers["lobu-memory"]).toEqual({
      url: WORKER_MCP_URL,
      originalUrl: "http://127.0.0.1:8787/mcp/acme",
      type: "sse",
      internal: true,
      perAgent: true,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Mcp-Id": "lobu-memory",
      },
    });
  });

  test("exposes lobu-memory proxy metadata and status", async () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async () => "acme",
      },
    });

    await expect(service.getMcpStatus("agent1")).resolves.toEqual([
      {
        id: "lobu-memory",
        name: "lobu-memory",
        requiresAuth: false,
        requiresInput: false,
      },
    ]);

    await expect(service.getHttpServer("lobu-memory", "agent1")).resolves.toEqual({
      id: "lobu-memory",
      upstreamUrl: "http://127.0.0.1:8787/mcp/acme",
      internal: true,
    });

    const all = await service.getAllHttpServers("agent1");
    expect([...all.keys()]).toEqual(["lobu-memory"]);
  });

  test("rejects invalid worker tokens", async () => {
    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async () => "acme",
      },
    });

    const config = await service.getWorkerConfig({
      baseUrl: WORKER_MCP_URL,
      workerToken: "not-a-token",
    });

    expect(config.mcpServers).toEqual({});
  });
});
