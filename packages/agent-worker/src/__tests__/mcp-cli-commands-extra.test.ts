import { afterEach, describe, expect, mock, test } from "bun:test";
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

const lobuTool: McpToolDef = {
  name: "search_knowledge",
  description: "Search the memory store",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const longTool: McpToolDef = {
  // description is over 80 chars to exercise truncate's slice branch
  name: "long_tool",
  description:
    "  This is a very long description with    repeated\nwhitespace that will definitely exceed the 80 character truncation cap.   ",
  inputSchema: {},
};

const undescribedTool: McpToolDef = {
  name: "noop",
  inputSchema: {},
};

// ---------------------------------------------------------------------------
// Reserved-name + denylist edge cases
// ---------------------------------------------------------------------------

describe("isMcpIdReserved (edge cases)", () => {
  test.each([
    "cd",
    "echo",
    "export",
    "test",
    "true",
    "false",
    "set",
    "unset",
  ])("rejects bash builtin %s", (name) => {
    expect(isMcpIdReserved(name)).toContain("reserved");
  });

  test.each([".", ":", "["])("rejects POSIX builtin %s", (name) => {
    expect(isMcpIdReserved(name)).toContain("reserved");
  });

  test("rejects pip and other denylisted package managers", () => {
    expect(isMcpIdReserved("pip")).toContain("package-install");
    expect(isMcpIdReserved("yarn")).toContain("package-install");
  });
});

// ---------------------------------------------------------------------------
// renderHelp coverage for contextPrefix and empty-tools branches
// ---------------------------------------------------------------------------

describe("renderHelp branches via --help", () => {
  test("includes mcpContext prefix when present", async () => {
    const ref = makeRef({
      mcpTools: { lobu: [lobuTool] },
      mcpStatus: [
        {
          id: "lobu",
          name: "Lobu",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
      mcpContext: { lobu: "Lobu session: 12 facts in memory." },
    });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });
    const out = await handler(["--help"], {});
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Lobu session: 12 facts in memory.");
    // requiresAuth=false → no auth line
    expect(out.stdout).not.toContain("auth login|check|logout");
  });

  test("renders empty-tools advisory when no tools discovered", async () => {
    const ref = makeRef({
      mcpTools: { gmail: [] },
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
    const handler = buildMcpServerHandler("gmail", ref, gw, {
      callTool: async () => ({ content: [] }),
    });
    const out = await handler(["--help"], {});
    expect(out.stdout).toContain("(no tools discovered");
    expect(out.stdout).toContain("auth login|check|logout");
  });

  test("-h alias also renders help", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });
    const out = await handler(["-h"], {});
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("MCP server CLI");
  });

  test("truncates long tool descriptions and collapses whitespace", async () => {
    const ref = makeRef({ mcpTools: { lobu: [longTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });
    const out = await handler(["--help"], {});
    // Truncation appends an ellipsis when over 80 chars
    expect(out.stdout).toContain("…");
    // No newlines preserved inside the description line
    const toolLine = out.stdout
      .split("\n")
      .find((l) => l.includes("long_tool"));
    expect(toolLine).toBeDefined();
    expect(toolLine).not.toContain("\n");
  });

  test("renders tool with no description without trailing whitespace", async () => {
    const ref = makeRef({ mcpTools: { lobu: [undescribedTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });
    const out = await handler(["--help"], {});
    const toolLine = out.stdout.split("\n").find((l) => l.trim() === "noop");
    expect(toolLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// summariseAuthStart unknown-status passthrough + tryJson edge cases
// ---------------------------------------------------------------------------

describe("summariseAuthStart edge cases", () => {
  test("falls through to raw text on unknown status", () => {
    const raw = JSON.stringify({ status: "weird_unknown_status", x: 1 });
    expect(summariseAuthStart(raw, "lobu")).toBe(raw);
  });

  test("returns raw text when JSON parse fails", () => {
    expect(summariseAuthStart("not json", "lobu")).toBe("not json");
  });

  test("returns raw text when payload is a JSON array (not object)", () => {
    const raw = "[1,2,3]";
    expect(summariseAuthStart(raw, "lobu")).toBe(raw);
  });
});

describe("summariseAuthCheck edge cases", () => {
  test("defaults missing fields to unknown/false", () => {
    const out = summariseAuthCheck({}, "lobu", "raw");
    expect(JSON.parse(out)).toEqual({
      status: "unknown",
      mcp_id: "lobu",
      authenticated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// runAuthSubcommand — exercised via buildMcpServerHandler with fetch mocks
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("auth subcommand routing", () => {
  test("auth login (already authenticated) returns short status", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/device-auth/status")) {
        return Response.json({ authenticated: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const ref = makeRef({
      mcpStatus: [
        {
          id: "lobu",
          name: "Lobu",
          requiresAuth: true,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "login"], {});
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("already_authenticated");
    expect(parsed.mcp_id).toBe("lobu");
  });

  test("auth check (pending) emits authenticated=false and skips refresh", async () => {
    let refreshed = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/device-auth/status")) {
        return Response.json({ authenticated: false });
      }
      if (url.includes("/internal/device-auth/poll")) {
        return Response.json({ status: "pending" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const ref: McpRuntimeRef = {
      current: {
        mcpTools: {},
        mcpStatus: [],
        mcpContext: {},
      },
      refresh: async () => {
        refreshed += 1;
        return null;
      },
    };
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "check"], {});
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.status).toBe("pending");
    expect(parsed.authenticated).toBe(false);
    expect(refreshed).toBe(0);
  });

  test("auth check (authenticated) triggers refresh and updates state", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/device-auth/status")) {
        return Response.json({ authenticated: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    let refreshCalls = 0;
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: {},
        mcpStatus: [],
        mcpContext: {},
      },
      refresh: async () => {
        refreshCalls += 1;
        return {
          mcpTools: { lobu: [lobuTool] },
          mcpStatus: [],
          mcpContext: {},
        };
      },
    };
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "check"], {});
    expect(r.exitCode).toBe(0);
    expect(refreshCalls).toBe(1);
    expect(ref.current.mcpTools.lobu).toEqual([lobuTool]);
  });

  test("auth check refresh failure is swallowed (does not throw)", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/device-auth/status")) {
        return Response.json({ authenticated: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const ref: McpRuntimeRef = {
      current: { mcpTools: {}, mcpStatus: [], mcpContext: {} },
      refresh: async () => {
        throw new Error("session ctx down");
      },
    };
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "check"], {});
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim()).authenticated).toBe(true);
  });

  test("auth logout returns server text and refreshes state", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/device-auth/credential")) {
        return Response.json({ success: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    let refreshed = 0;
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: { lobu: [lobuTool] },
        mcpStatus: [],
        mcpContext: {},
      },
      refresh: async () => {
        refreshed += 1;
        return {
          mcpTools: {},
          mcpStatus: [],
          mcpContext: {},
        };
      },
    };
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "logout"], {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("logged_out");
    expect(refreshed).toBe(1);
    expect(ref.current.mcpTools).toEqual({});
  });

  test("auth logout with no refresh on the ref still succeeds", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true })
    ) as unknown as typeof fetch;

    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "logout"], {});
    expect(r.exitCode).toBe(0);
  });

  test("auth without verb returns helpful error", async () => {
    const ref = makeRef();
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown auth subcommand");
    expect(r.stderr).toContain("login|check|logout");
  });

  test("auth unknown verb returns helpful error", async () => {
    const ref = makeRef();
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const r = await handler(["auth", "renew"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown auth subcommand: renew");
  });
});

// ---------------------------------------------------------------------------
// parsePayload extras (whitespace inline, scalar JSON)
// ---------------------------------------------------------------------------

describe("parsePayload further edge cases", () => {
  test("rejects scalar JSON (string)", () => {
    const r = parsePayload('"just a string"', undefined);
    expect(r.ok).toBe(false);
  });

  test("rejects scalar JSON (number)", () => {
    const r = parsePayload("42", undefined);
    expect(r.ok).toBe(false);
  });

  test("inline arg whitespace is treated as empty", () => {
    expect(parsePayload(undefined, "   ")).toEqual({ ok: true, payload: {} });
  });
});

// ---------------------------------------------------------------------------
// buildMcpCliCommands edge cases
// ---------------------------------------------------------------------------

describe("buildMcpCliCommands edge cases", () => {
  test("dedupes server ids that appear in both mcpTools and mcpStatus", () => {
    const ref = makeRef({
      mcpTools: { lobu: [lobuTool] },
      mcpStatus: [
        {
          id: "lobu",
          name: "Lobu",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const cmds = buildMcpCliCommands(ref, gw);
    expect(cmds.map((c) => c.name)).toEqual(["lobu"]);
  });

  test("returns empty list when nothing is registered", () => {
    expect(buildMcpCliCommands(makeRef(), gw)).toEqual([]);
  });

  test("registers servers that have no tools (auth-pending case)", () => {
    const ref = makeRef({
      mcpStatus: [
        {
          id: "linear",
          name: "Linear",
          requiresAuth: true,
          requiresInput: false,
          authenticated: false,
          configured: true,
        },
      ],
    });
    const cmds = buildMcpCliCommands(ref, gw);
    expect(cmds.map((c) => c.name)).toEqual(["linear"]);
  });
});
