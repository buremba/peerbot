/**
 * Worker-side MCP tool call tests (callMcpTool)
 *
 * callMcpTool is the function the agent calls to invoke an MCP tool via the
 * gateway proxy. It routes to POST /mcp/<mcpId>/tools/<toolName> using the
 * worker's JWT, then normalises the JSON response into the shared TextResult
 * shape. These tests cover:
 *
 *   - Happy path: content text forwarded
 *   - isError=true response: wrapped in "Error: ..." prefix
 *   - Non-200 HTTP: error text extracted
 *   - Empty content array: falls back to "<toolName> completed."
 *   - Correct Authorization header forwarding
 *   - Unknown tool name (404 from proxy): error wrapped
 *   - Tool approval required (403): error message surfaced to model
 *   - fetch throws: caught and returned as error text
 *   - AskUser / UploadFile: gateway error propagation
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  askUserQuestion,
  callMcpTool,
  uploadUserFile,
} from "../shared/tool-implementations";
import type { GatewayParams } from "../shared/tool-implementations";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "tok-abc",
  channelId: "ch-1",
  conversationId: "conv-1",
  platform: "telegram",
};

function extractText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

// ---------------------------------------------------------------------------
// callMcpTool happy path
// ---------------------------------------------------------------------------

describe("callMcpTool", () => {
  test("happy path: forwards content text from proxy response", async () => {
    let capturedUrl = "";
    let capturedAuth = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl =
          typeof input === "string" ? input : (input as Request).url;
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json({
          content: [{ type: "text", text: "the answer" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "search_memory", {
      query: "test",
    });

    expect(extractText(result)).toBe("the answer");
    expect(capturedUrl).toBe("http://gateway/mcp/lobu/tools/search_memory");
    expect(capturedAuth).toBe("Bearer tok-abc");
  });

  test("isError=true from proxy: wrapped in Error prefix", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [{ type: "text", text: "not allowed" }],
        isError: true,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "delete_repo", {
      name: "myrepo",
    });

    expect(extractText(result)).toContain("Error:");
    expect(extractText(result)).toContain("not allowed");
  });

  test("non-200 HTTP status: error message surfaced", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "Tool approval required", content: [], isError: true },
        { status: 403 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "create_issue", {});

    expect(extractText(result)).toContain("Error:");
  });

  test("empty content array falls back to '<toolName> completed.'", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "noop_tool", {});

    expect(extractText(result)).toBe("noop_tool completed.");
  });

  test("error field on response used as error message", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { content: [], isError: true, error: "Upstream timed out" },
        { status: 502 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "sentry", "resolve_issue", {});

    expect(extractText(result)).toContain("Upstream timed out");
  });

  test("fetch throws (network down): error returned as text", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "search_memory", {});

    expect(extractText(result)).toContain("network unreachable");
  });

  test("unknown tool name (404): error wrapped", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "MCP server 'ghost' not found", content: [], isError: true },
        { status: 404 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "ghost", "missing_tool", {});

    expect(extractText(result)).toContain("Error:");
  });

  test("multiple content items concatenated", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "multi_content", {});

    const text = extractText(result);
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  test("non-text content items are filtered from output", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "image", data: "base64..." },
          { type: "text", text: "the text" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "mixed_content", {});

    // Only the text item should appear
    expect(extractText(result)).toBe("the text");
  });

  test("sends correct Content-Type header", async () => {
    let capturedContentType = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedContentType =
          new Headers(init?.headers).get("Content-Type") ?? "";
        return Response.json({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    await callMcpTool(gw, "lobu", "search_memory", { q: "hello" });

    expect(capturedContentType).toBe("application/json");
  });

  test("sends POST method", async () => {
    let capturedMethod = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "";
        return Response.json({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    await callMcpTool(gw, "lobu", "search_memory", {});

    expect(capturedMethod).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// ask_user edge cases
// ---------------------------------------------------------------------------

describe("askUserQuestion edge cases", () => {
  test("gateway HTTP error surfaced as error text", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "channel not found" }, { status: 404 })
    ) as unknown as typeof fetch;

    const result = await askUserQuestion(gw, {
      question: "Pick?",
      options: ["A"],
    });

    expect(extractText(result)).toContain("Error:");
  });

  test("sends correct interaction type", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ id: "q-1" });
      }
    ) as unknown as typeof fetch;

    await askUserQuestion(gw, {
      question: "Yes or No?",
      options: ["Yes", "No"],
    });

    expect(body?.interactionType).toBe("question");
  });
});

// ---------------------------------------------------------------------------
// upload_file edge cases
// ---------------------------------------------------------------------------

describe("uploadUserFile edge cases", () => {
  test("upload HTTP error surfaced as error text", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-up-err-"));
    const filePath = join(tempDir, "f.txt");
    writeFileSync(filePath, "content");

    globalThis.fetch = mock(
      async () => new Response("Forbidden", { status: 403 })
    ) as unknown as typeof fetch;

    try {
      const result = await uploadUserFile(gw, { file_path: filePath });
      expect(extractText(result as any)).toContain("Error:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("relative path without workspaceDir returns error", async () => {
    const result = await uploadUserFile(gw, { file_path: "relative/path.txt" });
    expect(extractText(result as any)).toContain("workspaceDir not set");
  });

  test("directory path (not a file) returns error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-dir-test-"));
    try {
      const result = await uploadUserFile(gw, { file_path: tempDir });
      expect(extractText(result as any)).toContain(
        "not found or is not a file"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("empty file returns error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-empty-"));
    const filePath = join(tempDir, "empty.txt");
    writeFileSync(filePath, "");

    try {
      const result = await uploadUserFile(gw, { file_path: filePath });
      expect(extractText(result as any)).toContain("Cannot show empty file");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-policy integration: callMcpTool approval-blocked response
// ---------------------------------------------------------------------------

describe("callMcpTool: approval-blocked response from gateway", () => {
  test("403 with requires-approval text surfaces as Error prefix", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          content: [
            {
              type: "text",
              text: "Tool call requires approval. The user has been asked to approve.",
            },
          ],
          isError: true,
        },
        { status: 403 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "delete_branch", {
      branch: "main",
    });

    const text = extractText(result);
    expect(text).toContain("Error:");
    expect(text).toContain("requires approval");
  });
});
