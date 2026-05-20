import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as internal from "../../../internal/index.js";
import { mcpRpc } from "./mcp.js";
import { getSessionForOrg, getUsableToken } from "./openclaw-auth.js";
import { memoryRunCommand } from "../run.js";

const CLOUD_MCP_URL = "https://lobu.ai/mcp";

function mockProdMemoryContext() {
  spyOn(internal, "resolveContext").mockResolvedValue({
    name: "prod",
    url: "https://community.lobu.ai/api/v1",
    source: "config",
  });
  spyOn(internal, "getMemoryUrl").mockImplementation(async () => CLOUD_MCP_URL);
  spyOn(internal, "getActiveOrg").mockImplementation(async () => "buremba");
  spyOn(internal, "findContextByMemoryUrl").mockResolvedValue({
    name: "lobu",
    url: "https://app.lobu.ai/api/v1",
    source: "default",
  });
  spyOn(internal, "getToken").mockImplementation(async (contextName) =>
    contextName === "prod" ? "prod-token" : null
  );
}

describe("memory auth URL resolution", () => {
  afterEach(() => {
    mock.restore();
    delete process.env.LOBU_API_TOKEN;
  });

  test("getSessionForOrg honors an explicit --url", async () => {
    const session = await getSessionForOrg(
      "dev",
      undefined,
      "http://localhost:8801"
    );
    expect(session?.key).toBe("http://localhost:8801/mcp/dev");
  });

  test("getUsableToken keeps the active context when memory URL matches", async () => {
    mockProdMemoryContext();

    const result = await getUsableToken("https://lobu.ai/mcp/buremba");

    expect(result?.token).toBe("prod-token");
    expect(result?.contextName).toBe("prod");
    expect(result?.session.org).toBe("buremba");
    expect(internal.findContextByMemoryUrl).not.toHaveBeenCalled();
  });

  test("memory run sends the active context token to the MCP server", async () => {
    mockProdMemoryContext();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer prod-token",
      });
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { "mcp-session-id": "test-session" },
        });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            result: { tools: [{ name: "search_memory" }] },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await memoryRunCommand(undefined, undefined, { org: "buremba" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("search_memory")
    );
  });

  test("MCP 401 errors include the selected context", async () => {
    mockProdMemoryContext();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        })
    ) as unknown as typeof fetch;

    try {
      await expect(
        mcpRpc("https://lobu.ai/mcp/buremba", "tools/list")
      ).rejects.toThrow(/using context "prod"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const e2e = process.env.LOBU_E2E_MEMORY === "1" ? test : test.skip;

  e2e("memory run works against a real MCP server", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true
    );

    await memoryRunCommand("list_organizations", "{}", {
      context: process.env.LOBU_E2E_CONTEXT,
      org: process.env.LOBU_E2E_MEMORY_ORG,
    });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("content"));
  });
});
