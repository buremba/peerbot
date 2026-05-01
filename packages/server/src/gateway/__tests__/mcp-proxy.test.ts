import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken, type SecretRef } from "@lobu/core";
import { MockMessageQueue } from "@lobu/core/testing";
import { McpProxy } from "../auth/mcp/proxy.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";
import { GrantStore } from "../permissions/grant-store.js";
import {
  type SecretListEntry,
  type WritableSecretStore,
} from "../secrets/index.js";

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<string, { value: string; updatedAt: number }>();
  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith("secret://")) return null;
    const name = decodeURIComponent(ref.slice("secret://".length));
    return this.entries.get(name)?.value ?? null;
  }
  async put(name: string, value: string): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `secret://${encodeURIComponent(name)}` as SecretRef;
  }
  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith("secret://")
      ? decodeURIComponent(nameOrRef.slice("secret://".length))
      : nameOrRef;
    this.entries.delete(name);
  }
  async list(prefix?: string): Promise<SecretListEntry[]> {
    const out: SecretListEntry[] = [];
    for (const [name, e] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      out.push({
        ref: `secret://${encodeURIComponent(name)}` as SecretRef,
        backend: "memory",
        name,
        updatedAt: e.updatedAt,
      });
    }
    return out;
  }
}

function createTestSecretStore(_queue: MockMessageQueue): InMemoryWritableStore {
  return new InMemoryWritableStore();
}

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
}

interface McpConfigSource {
  getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined>;
  getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>>;
}

function createMockConfigSource(
  servers: Record<string, HttpMcpServerConfig>
): McpConfigSource {
  return {
    getHttpServer: async (id) => servers[id],
    getAllHttpServers: async () => new Map(Object.entries(servers)),
  };
}

function mockUpstreamFetch(responseData: any) {
  globalThis.fetch = async () => {
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const TEST_SERVER: HttpMcpServerConfig = {
  id: "test-mcp",
  upstreamUrl: "http://upstream:9000/mcp",
};

let originalEnv: string | undefined;
let validToken: string;
let originalFetch: typeof fetch;

beforeAll(async () => {
  // GrantStore is now PG-backed; bring up an ephemeral PGlite for the
  // tool-approval tests below. Seed `agent1` so the grants FK accepts
  // inserts keyed on it.
  const { ensurePgliteForGatewayTests, seedAgentRow } = await import(
    "./helpers/db-setup.js"
  );
  await ensurePgliteForGatewayTests();
  await seedAgentRow("agent1");
  originalEnv = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  validToken = generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId: "agent1",
  });
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  if (originalEnv !== undefined) process.env.ENCRYPTION_KEY = originalEnv;
  else delete process.env.ENCRYPTION_KEY;
  globalThis.fetch = originalFetch;
});

describe("McpProxy", () => {
  let queue: MockMessageQueue;

  beforeEach(() => {
    queue = new MockMessageQueue();
    globalThis.fetch = originalFetch;
  });

  // ---------- Auth tests ----------

  describe("authentication", () => {
    test("rejects missing token", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools", { method: "GET" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid authentication token");
    });

    test("rejects invalid token", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: "Bearer invalid-garbage" },
      });
      expect(res.status).toBe(401);
    });

    test("accepts Bearer header", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "tool1" }] },
      });

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
    });

    test("rejects workerToken query param", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "tool1" }] },
      });

      const res = await app.request(
        `/test-mcp/tools?workerToken=${validToken}`,
        { method: "GET" }
      );
      expect(res.status).toBe(401);
    });
  });

  // ---------- GET /:mcpId/tools ----------

  describe("GET /:mcpId/tools", () => {
    test("returns tools from upstream", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const tools = [
        { name: "read_file", description: "Read a file" },
        { name: "write_file", description: "Write a file" },
      ];
      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools },
      });

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe("read_file");
      expect(body.tools[1].name).toBe("write_file");
    });

    test("returns 404 for unknown MCP", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const res = await app.request("/nonexistent/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    test("returns 502 on upstream error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      globalThis.fetch = async () => {
        throw new Error("Connection refused");
      };

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Failed to connect");
    });

    test("caches tools on second request", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const toolCache = new McpToolCache();
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
        toolCache,
      });
      const app = proxy.getApp();

      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "cached_tool" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      // First request fetches from upstream
      const res1 = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res1.status).toBe(200);
      const firstFetchCount = fetchCount;

      // Second request should use cache
      const res2 = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res2.status).toBe(200);
      const body = await res2.json();
      expect(body.tools[0].name).toBe("cached_tool");
      // fetch should NOT have been called again
      expect(fetchCount).toBe(firstFetchCount);
    });
  });

  // ---------- POST /:mcpId/tools/:toolName ----------

  describe("POST /:mcpId/tools/:toolName", () => {
    test("forwards call and returns result", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Hello world" }],
          isError: false,
        },
      });

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ arg1: "value1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toHaveLength(1);
      expect(body.content[0].text).toBe("Hello world");
      expect(body.isError).toBe(false);
    });

    test("returns 400 for invalid JSON body", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: "not valid json {{{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid JSON");
    });

    test("returns 404 for unknown MCP", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      const res = await app.request("/nonexistent/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    test("returns 502 on upstream error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      globalThis.fetch = async () => {
        throw new Error("Connection refused");
      };

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Failed to connect");
    });
  });

  // ---------- Session re-init ----------

  describe("session re-initialization", () => {
    test("retries on 'Server not initialized' error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        // The first call is the tool call that triggers the error.
        // After that, reinitializeSession sends initialize + notifications/initialized (2 calls).
        // Then the retry tool call is the 4th call.
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "Server not initialized" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // Re-init calls (initialize + notifications/initialized) and retry
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: "Success after re-init" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content[0].text).toBe("Success after re-init");
      // At least 4 fetch calls: original + initialize + notify + retry
      expect(callCount).toBeGreaterThanOrEqual(4);
    });
  });

  // ---------- Tool approval ----------

  describe("tool approval", () => {
    function createProxyWithGrants(
      servers: Record<string, HttpMcpServerConfig>
    ) {
      const configSource = createMockConfigSource(servers);
      const toolCache = new McpToolCache();
      const grantStore = new GrantStore();
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
        toolCache,
        grantStore,
      });
      return { proxy, toolCache, grantStore, configSource };
    }

    test("blocks destructive tool without grant", async () => {
      const { proxy, toolCache } = createProxyWithGrants({
        "test-mcp": TEST_SERVER,
      });
      const app = proxy.getApp();

      // Pre-populate cache with a tool that has no annotations (default destructive)
      await toolCache.set("test-mcp", [{ name: "dangerous_tool" }], "agent1");

      const res = await app.request("/test-mcp/tools/dangerous_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.isError).toBe(true);
      expect(body.content[0].text).toContain("requires approval");
    });

    test("allows with grant", async () => {
      const { proxy, toolCache, grantStore } = createProxyWithGrants({
        "test-mcp": TEST_SERVER,
      });
      const app = proxy.getApp();

      // Pre-populate cache with a tool that has no annotations (default destructive)
      await toolCache.set("test-mcp", [{ name: "dangerous_tool" }], "agent1");

      // Grant access
      await grantStore.grant(
        "agent1",
        "/mcp/test-mcp/tools/dangerous_tool",
        null
      );

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Executed" }],
          isError: false,
        },
      });

      const res = await app.request("/test-mcp/tools/dangerous_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content[0].text).toBe("Executed");
    });

    test("allows readOnlyHint=true without grant", async () => {
      const { proxy, toolCache } = createProxyWithGrants({
        "test-mcp": TEST_SERVER,
      });
      const app = proxy.getApp();

      // Pre-populate cache with a read-only tool
      await toolCache.set(
        "test-mcp",
        [{ name: "read_tool", annotations: { readOnlyHint: true } }],
        "agent1"
      );

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Read data" }],
          isError: false,
        },
      });

      const res = await app.request("/test-mcp/tools/read_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    test("allows destructiveHint=false without grant", async () => {
      const { proxy, toolCache } = createProxyWithGrants({
        "test-mcp": TEST_SERVER,
      });
      const app = proxy.getApp();

      // Pre-populate cache with a non-destructive tool
      await toolCache.set(
        "test-mcp",
        [{ name: "safe_tool", annotations: { destructiveHint: false } }],
        "agent1"
      );

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Safe result" }],
          isError: false,
        },
      });

      const res = await app.request("/test-mcp/tools/safe_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });
  });

  // ---------- GET /tools (list all) ----------

  describe("GET /tools", () => {
    test("lists tools from all MCPs", async () => {
      const configSource = createMockConfigSource({
        mcp1: {
          id: "mcp1",
          upstreamUrl: "http://upstream1:9000/mcp",
        },
        mcp2: {
          id: "mcp2",
          upstreamUrl: "http://upstream2:9000/mcp",
        },
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        const tools = urlStr.includes("upstream1")
          ? [{ name: "tool_a" }]
          : [{ name: "tool_b" }];
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await app.request("/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mcpServers.mcp1.tools[0].name).toBe("tool_a");
      expect(body.mcpServers.mcp2.tools[0].name).toBe("tool_b");
    });

    test("tolerates individual MCP failures", async () => {
      const configSource = createMockConfigSource({
        good: {
          id: "good",
          upstreamUrl: "http://good-upstream:9000/mcp",
        },
        bad: {
          id: "bad",
          upstreamUrl: "http://bad-upstream:9000/mcp",
        },
      });
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });
      const app = proxy.getApp();

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("bad-upstream")) {
          throw new Error("Connection refused");
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "working_tool" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await app.request("/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The "good" MCP should still have its tools
      expect(body.mcpServers.good.tools[0].name).toBe("working_tool");
      // The "bad" MCP should be absent (empty tools are filtered out)
      expect(body.mcpServers.bad).toBeUndefined();
    });
  });

  // ---------- isMcpRequest ----------

  describe("isMcpRequest", () => {
    test("returns true with x-mcp-id header", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });

      // Use a wrapper Hono app to get a real Context object
      const { Hono } = await import("hono");
      const wrapper = new Hono();
      let result = false;
      wrapper.all("/*", (c) => {
        result = proxy.isMcpRequest(c);
        return c.json({ result });
      });

      await wrapper.request("/anything", {
        method: "GET",
        headers: { "x-mcp-id": "some-mcp" },
      });
      expect(result).toBe(true);
    });

    test("returns false without x-mcp-id header", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, queue as any, {
        secretStore: createTestSecretStore(queue),
      });

      const { Hono } = await import("hono");
      const wrapper = new Hono();
      let result = true;
      wrapper.all("/*", (c) => {
        result = proxy.isMcpRequest(c);
        return c.json({ result });
      });

      await wrapper.request("/anything", { method: "GET" });
      expect(result).toBe(false);
    });
  });
});
