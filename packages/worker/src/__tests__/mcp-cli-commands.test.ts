import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import {
  buildMcpCliCommands,
  buildMcpServerHandler,
  isMcpIdReserved,
  type McpRuntimeRef,
  type McpRuntimeState,
  parsePayload,
  summariseAuthCheck,
  summariseAuthStart,
} from "../embedded/mcp-cli-commands";
import type { GatewayParams } from "../shared/tool-implementations";

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "worker-token",
  channelId: "channel-1",
  conversationId: "conversation-1",
  platform: "telegram",
};

function makeRef(overrides: Partial<McpRuntimeState> = {}): McpRuntimeRef {
  return {
    current: {
      mcpTools: overrides.mcpTools ?? {},
      mcpStatus: overrides.mcpStatus ?? [],
      mcpContext: overrides.mcpContext ?? {},
    },
  };
}

const owlettoTool: McpToolDef = {
  name: "search_knowledge",
  description: "Search the memory store",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("parsePayload", () => {
  test("empty stdin and no inline arg yields empty object", () => {
    expect(parsePayload(undefined, undefined)).toEqual({
      ok: true,
      payload: {},
    });
  });

  test("whitespace stdin yields empty object", () => {
    expect(parsePayload("   \n", undefined)).toEqual({
      ok: true,
      payload: {},
    });
  });

  test("parses JSON from stdin", () => {
    expect(parsePayload('{"q":"hello"}', undefined)).toEqual({
      ok: true,
      payload: { q: "hello" },
    });
  });

  test("falls back to inline arg when stdin empty", () => {
    expect(parsePayload("", '{"q":"x"}')).toEqual({
      ok: true,
      payload: { q: "x" },
    });
  });

  test("rejects non-object JSON (array)", () => {
    const result = parsePayload("[1, 2, 3]", undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects malformed JSON", () => {
    const result = parsePayload("{not json", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });
});

describe("isMcpIdReserved", () => {
  test("rejects bash builtins", () => {
    expect(isMcpIdReserved("cd")).toContain("reserved");
    expect(isMcpIdReserved("echo")).toContain("reserved");
  });

  test("rejects package-manager ids", () => {
    expect(isMcpIdReserved("npm")).toContain("package-install");
    expect(isMcpIdReserved("pip")).toContain("package-install");
  });

  test("allows normal MCP ids", () => {
    expect(isMcpIdReserved("owletto")).toBeNull();
    expect(isMcpIdReserved("gmail")).toBeNull();
  });
});

describe("buildMcpServerHandler", () => {
  test("--help lists tools and usage", async () => {
    const ref = makeRef({
      mcpTools: { owletto: [owlettoTool] },
      mcpStatus: [
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: true,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["--help"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("owletto — MCP server CLI");
    expect(result.stdout).toContain("search_knowledge");
    expect(result.stdout).toContain("auth login|check|logout");
  });

  test("--schema prints JSON schema for a known tool", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["search_knowledge", "--schema"], {});
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(owlettoTool.inputSchema);
  });

  test("--schema on unknown tool exits 2", async () => {
    const ref = makeRef({ mcpTools: { owletto: [] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["nope", "--schema"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown tool");
  });

  test("tool invocation parses JSON from stdin and routes to callTool", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const calls: Array<{
      mcpId: string;
      toolName: string;
      payload: Record<string, unknown>;
    }> = [];
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async (_gw, mcpId, toolName, payload) => {
        calls.push({ mcpId, toolName, payload });
        return { content: [{ type: "text", text: "search ok" }] };
      },
    });

    const result = await handler(["search_knowledge"], {
      stdin: '{"query":"architecture"}',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("search ok");
    expect(calls).toEqual([
      {
        mcpId: "owletto",
        toolName: "search_knowledge",
        payload: { query: "architecture" },
      },
    ]);
  });

  test("tool invocation falls back to args[1] when stdin is empty", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const captured: Record<string, unknown>[] = [];
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, payload) => {
        captured.push(payload);
        return { content: [] };
      },
    });

    const result = await handler(
      ["search_knowledge", '{"query":"inline"}'],
      {}
    );
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual([{ query: "inline" }]);
  });

  test("tool invocation defaults to empty object when no payload given", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const captured: Record<string, unknown>[] = [];
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, payload) => {
        captured.push(payload);
        return { content: [] };
      },
    });

    const result = await handler(["search_knowledge"], {});
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual([{}]);
  });

  test("invalid JSON payload exits 2", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => {
        throw new Error("should not be called");
      },
    });

    const result = await handler(["search_knowledge"], { stdin: "{not json" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid JSON");
  });

  test("unknown tool exits 2", async () => {
    const ref = makeRef({ mcpTools: { owletto: [] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["mystery"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown tool");
  });

  test("callTool throwing surfaces as exitCode 1", async () => {
    const ref = makeRef({ mcpTools: { owletto: [owlettoTool] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => {
        throw new Error("network down");
      },
    });

    const result = await handler(["search_knowledge"], { stdin: "{}" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network down");
  });

  test("reads mcpTools through ref.current on each invocation", async () => {
    // Start empty, then mutate the ref and confirm the handler picks up new tools.
    const ref = makeRef({ mcpTools: { owletto: [] } });
    const handler = buildMcpServerHandler("owletto", ref, gw, {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const r1 = await handler(["search_knowledge"], {});
    expect(r1.exitCode).toBe(2);

    ref.current = {
      ...ref.current,
      mcpTools: { owletto: [owlettoTool] },
    };

    const r2 = await handler(["search_knowledge"], { stdin: "{}" });
    expect(r2.exitCode).toBe(0);
  });
});

describe("buildMcpCliCommands", () => {
  test("builds one command per MCP server", () => {
    const ref = makeRef({
      mcpTools: { owletto: [owlettoTool] },
      mcpStatus: [
        {
          id: "gmail",
          name: "Gmail",
          requiresAuth: true,
          requiresInput: false,
          authenticated: false,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands.map((c) => c.name).sort()).toEqual(["gmail", "owletto"]);
  });

  test("skips MCP ids that collide with bash builtins", () => {
    const ref = makeRef({
      mcpStatus: [
        {
          id: "echo",
          name: "Echo",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands.map((c) => c.name)).toEqual(["owletto"]);
  });

  test("skips MCP ids that collide with package-install denylist", () => {
    const ref = makeRef({
      mcpStatus: [
        {
          id: "npm",
          name: "Not npm",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands).toEqual([]);
  });
});

describe("summariseAuthStart / summariseAuthCheck", () => {
  test("summariseAuthStart collapses login_started to a short status without URL", () => {
    const out = summariseAuthStart(
      JSON.stringify({
        status: "login_started",
        verification_url: "https://example.com/verify",
        interaction_posted: true,
      }),
      "owletto"
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("login_started");
    expect(parsed.mcp_id).toBe("owletto");
    expect(parsed.interaction_posted).toBe(true);
    expect(out).not.toContain("https://example.com/verify");
  });

  test("summariseAuthStart passes through already_authenticated", () => {
    const out = summariseAuthStart(
      JSON.stringify({ status: "already_authenticated" }),
      "owletto"
    );
    expect(JSON.parse(out).status).toBe("already_authenticated");
  });

  test("summariseAuthStart falls through to raw when interaction_posted=false so URL stays reachable", () => {
    const raw = JSON.stringify({
      status: "login_started",
      verification_url: "https://example.com/verify",
      user_code: "ABCD-1234",
      interaction_posted: false,
    });
    const out = summariseAuthStart(raw, "owletto");
    expect(out).toBe(raw);
    expect(out).toContain("https://example.com/verify");
    expect(out).toContain("ABCD-1234");
  });

  test("summariseAuthCheck emits authenticated=true on success", () => {
    const out = summariseAuthCheck(
      { status: "authenticated", authenticated: true },
      "owletto",
      "raw"
    );
    expect(JSON.parse(out)).toEqual({
      status: "authenticated",
      mcp_id: "owletto",
      authenticated: true,
    });
  });

  test("summariseAuthCheck falls back to raw text when parse fails", () => {
    expect(summariseAuthCheck(null, "owletto", "raw text")).toBe("raw text");
  });
});
