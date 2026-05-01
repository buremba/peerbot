import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
  createMcpAuthToolDefinitions,
  createMcpToolDefinitions,
} from "../openclaw/custom-tools";
import {
  getOpenClawSessionContext,
  invalidateSessionContextCache,
} from "../openclaw/session-context";
import { createOpenClawTools } from "../openclaw/tools";
import { callMcpTool } from "../shared/tool-implementations";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "embedded-tools-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createOpenClawTools — tool count and names
// ---------------------------------------------------------------------------

describe("createOpenClawTools", () => {
  test("returns 7 tools (read, write, edit, bash, grep, find, ls)", () => {
    const tools = createOpenClawTools(tempDir);
    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
  });
});

// ---------------------------------------------------------------------------
// Bash tool with custom BashOperations
// ---------------------------------------------------------------------------

describe("bash tool with BashOperations", () => {
  test("uses provided BashOperations exec", async () => {
    let capturedCommand = "";
    let capturedCwd = "";
    const mockBashOps: BashOperations = {
      exec: async (command, cwd, { onData }) => {
        capturedCommand = command;
        capturedCwd = cwd;
        onData(Buffer.from("mock output\n"));
        return { exitCode: 0 };
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;
    expect(bashTool).toBeDefined();

    const result = await bashTool.execute(
      "call-1",
      { command: "echo hello" },
      undefined,
      undefined
    );
    expect(capturedCommand).toContain("echo hello");
    expect(capturedCwd).toBe(tempDir);
    // Result should contain the mock output
    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("mock output");
  });

  test("passes command string through correctly", async () => {
    const commands: string[] = [];
    const mockBashOps: BashOperations = {
      exec: async (command, _cwd, { onData }) => {
        commands.push(command);
        onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;

    await bashTool.execute(
      "call-2",
      { command: "ls -la /tmp && echo done" },
      undefined,
      undefined
    );
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands[0]).toContain("ls -la /tmp && echo done");
  });
});

// ---------------------------------------------------------------------------
// File tools with real filesystem
// ---------------------------------------------------------------------------

describe("file tools use real filesystem", () => {
  test("read tool reads a real file", async () => {
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    const result = await readTool.execute(
      "call-read",
      { path: filePath },
      undefined,
      undefined
    );
    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("hello world");
  });

  test("write tool creates a real file", async () => {
    const filePath = join(tempDir, "output.txt");

    const tools = createOpenClawTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write")!;
    await writeTool.execute(
      "call-write",
      { path: filePath, content: "new content" },
      undefined,
      undefined
    );
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toContain("new content");
  });
});

// ---------------------------------------------------------------------------
// Bash tool proxy hint wrapper
// ---------------------------------------------------------------------------

describe("bash tool proxy hint", () => {
  test("blocks direct package installs with error", async () => {
    const mockBashOps: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;

    const blockedCommands = [
      "apt install curl",
      "sudo apt-get install -y ffmpeg",
      "brew install node",
      "nix-shell -p python3",
      "pip install requests",
      "npm install -g @openai/codex",
      "bash -lc 'pnpm add zod'",
    ];

    for (const cmd of blockedCommands) {
      await expect(
        bashTool.execute("call-block", { command: cmd }, undefined, undefined)
      ).rejects.toThrow("DIRECT PACKAGE INSTALL BLOCKED");
    }
  });

  test("adds proxy hint for HTTP 403 from proxy errors", async () => {
    const mockBashOps: BashOperations = {
      exec: async () => {
        throw new Error("Received HTTP code 403 from proxy after CONNECT");
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;

    await expect(
      bashTool.execute(
        "call-proxy",
        { command: "curl https://blocked.example.com" },
        undefined,
        undefined
      )
    ).rejects.toThrow("DOMAIN BLOCKED BY PROXY");
  });

  test("blocks direct gateway API access from Bash", async () => {
    const mockBashOps: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    };

    const originalDispatcherUrl = process.env.DISPATCHER_URL;
    const originalWorkerToken = process.env.WORKER_TOKEN;
    process.env.DISPATCHER_URL = "http://gateway:8080";
    process.env.WORKER_TOKEN = "secret-token";

    try {
      const tools = createOpenClawTools(tempDir, {
        bashOperations: mockBashOps,
      });
      const bashTool = tools.find((t) => t.name === "bash")!;

      const blockedCommands = [
        'curl "$DISPATCHER_URL/mcp/github/tools/list_repos" -H "Authorization: Bearer $WORKER_TOKEN"',
        "curl http://gateway:8080/internal/device-auth/status?mcpId=github",
        'node -e \'fetch("http://gateway:8080/mcp/github/tools/list_repos", { method: "POST" })\'',
      ];

      for (const cmd of blockedCommands) {
        await expect(
          bashTool.execute(
            "call-gateway",
            { command: cmd },
            undefined,
            undefined
          )
        ).rejects.toThrow("DIRECT GATEWAY API ACCESS BLOCKED");
      }
    } finally {
      if (originalDispatcherUrl === undefined) {
        delete process.env.DISPATCHER_URL;
      } else {
        process.env.DISPATCHER_URL = originalDispatcherUrl;
      }
      if (originalWorkerToken === undefined) {
        delete process.env.WORKER_TOKEN;
      } else {
        process.env.WORKER_TOKEN = originalWorkerToken;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// callMcpTool
// ---------------------------------------------------------------------------

describe("callMcpTool", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const gw = {
    gatewayUrl: "http://gateway:8080",
    workerToken: "test-token-123",
    channelId: "ch-1",
    conversationId: "conv-1",
  };

  test("uses correct URL format", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url: any, _opts: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await callMcpTool(gw, "owletto", "list_connections", { limit: 5 });
    expect(capturedUrl).toBe(
      "http://gateway:8080/mcp/owletto/tools/list_connections"
    );
  });

  test("sends Authorization Bearer header", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedHeaders = opts?.headers || {};
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await callMcpTool(gw, "owletto", "test_tool", {});
    expect(capturedHeaders.Authorization).toBe("Bearer test-token-123");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });

  test("formats successful response as TextResult", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await callMcpTool(gw, "mcp1", "my_tool", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("line 1");
    expect(result.content[0].text).toContain("line 2");
  });

  test("handles error response (isError=true)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          isError: true,
          content: [{ type: "text", text: "something went wrong" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await callMcpTool(gw, "mcp1", "fail_tool", {});
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("something went wrong");
  });

  test("handles non-ok HTTP response", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "not found",
          content: [],
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );

    const result = await callMcpTool(gw, "mcp1", "missing_tool", {});
    expect(result.content[0].text).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// MCP auth tools
// ---------------------------------------------------------------------------

describe("createMcpAuthToolDefinitions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const gw = {
    gatewayUrl: "http://gateway:8080",
    workerToken: "worker-token",
    channelId: "channel-1",
    conversationId: "conv-1",
    platform: "slack",
  };

  test("creates login, login_check, and logout tools for auth-capable MCPs", () => {
    const tools = createMcpAuthToolDefinitions(
      [
        {
          id: "github",
          name: "GitHub",
          requiresAuth: true,
          authenticated: false,
          configured: true,
        },
        {
          id: "plain",
          name: "Plain",
          requiresAuth: false,
          authenticated: false,
          configured: true,
        },
      ] as any,
      gw
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "github_login",
      "github_login_check",
      "github_logout",
    ]);
  });

  test("skips auth tools that would collide with existing tool names", () => {
    const tools = createMcpAuthToolDefinitions(
      [
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: true,
          authenticated: false,
          configured: true,
        },
      ] as any,
      gw,
      new Set(["owletto_login"])
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "owletto_login_check",
      "owletto_logout",
    ]);
  });

  test("login tool returns a structured login_started payload", async () => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/internal/device-auth/status?mcpId=github")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.endsWith("/internal/device-auth/start") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            userCode: "CODE-123",
            verificationUri: "https://example.com/device",
            verificationUriComplete: "https://example.com/device?code=CODE-123",
            expiresIn: 600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      if (
        url.endsWith("/internal/interactions/create") &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ id: "link-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const [loginTool] = createMcpAuthToolDefinitions(
      [
        {
          id: "github",
          name: "GitHub",
          requiresAuth: true,
          authenticated: false,
          configured: true,
        },
      ] as any,
      gw
    );

    const result = await loginTool!.execute("call-1", {}, undefined, undefined);
    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const parsed = JSON.parse(text);

    expect(parsed.status).toBe("login_started");
    expect(parsed.mcp_id).toBe("github");
    expect(parsed.user_code).toBe("CODE-123");
    expect(parsed.interaction_posted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createMcpToolDefinitions
// ---------------------------------------------------------------------------

describe("createMcpToolDefinitions", () => {
  const gw = {
    gatewayUrl: "http://gateway:8080",
    workerToken: "tok",
    channelId: "ch",
    conversationId: "conv",
  };

  test("creates N ToolDefinitions for N MCP tools", () => {
    const mcpTools = {
      owletto: [
        { name: "list_connections", description: "List connections" },
        { name: "manage_connections", description: "Manage connections" },
      ],
      another: [{ name: "do_stuff" }],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    expect(defs).toHaveLength(3);
  });

  test("tool names match MCP tool names", () => {
    const mcpTools = {
      owletto: [
        { name: "list_connections", description: "List" },
        { name: "create_issue", description: "Create" },
      ],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    const names = defs.map((d) => d.name);
    expect(names).toContain("list_connections");
    expect(names).toContain("create_issue");
  });

  test("tool label includes mcpId", () => {
    const mcpTools = {
      owletto: [{ name: "test_tool", description: "Test" }],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    expect(defs[0].label).toBe("owletto/test_tool");
  });

  test("tool description includes mcpId when no description provided", () => {
    const mcpTools = {
      myserver: [{ name: "unnamed_tool" }],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    expect(defs[0].description).toContain("myserver");
  });

  test("uses provided description when available", () => {
    const mcpTools = {
      owletto: [
        { name: "list_connections", description: "List all connections" },
      ],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    expect(defs[0].description).toBe("List all connections");
  });

  test("prepends mcpContext instructions to tool descriptions", () => {
    const mcpTools = {
      owletto: [
        { name: "store_memory", description: "Store a memory entry" },
        { name: "recall_memory", description: "Recall stored memories" },
      ],
      other: [{ name: "do_thing", description: "Does a thing" }],
    };
    const mcpContext = {
      owletto: "Check memory at conversation start",
    };

    const defs = createMcpToolDefinitions(mcpTools, gw, mcpContext);

    expect(defs[0].description).toBe(
      "[Check memory at conversation start] Store a memory entry"
    );
    expect(defs[1].description).toBe(
      "[Check memory at conversation start] Recall stored memories"
    );
    // "other" has no context — description unchanged
    expect(defs[2].description).toBe("Does a thing");
  });

  test("works without mcpContext (backwards compatible)", () => {
    const mcpTools = {
      owletto: [{ name: "test_tool", description: "Original desc" }],
    };

    const defs = createMcpToolDefinitions(mcpTools, gw);
    expect(defs[0].description).toBe("Original desc");

    const defs2 = createMcpToolDefinitions(mcpTools, gw, undefined);
    expect(defs2[0].description).toBe("Original desc");

    const defs3 = createMcpToolDefinitions(mcpTools, gw, {});
    expect(defs3[0].description).toBe("Original desc");
  });

  test("execute calls callMcpTool with correct args", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = async (url: any, opts: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = opts?.body || "";
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "result data" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const mcpTools = {
        owletto: [{ name: "list_connections", description: "List" }],
      };

      const defs = createMcpToolDefinitions(mcpTools, gw);
      const tool = defs[0];

      const result = await tool.execute(
        "call-id",
        { limit: 10 },
        undefined,
        undefined,
        {} as any
      );

      expect(capturedUrl).toBe(
        "http://gateway:8080/mcp/owletto/tools/list_connections"
      );
      expect(JSON.parse(capturedBody)).toEqual({ limit: 10 });
      expect(result.content[0].text).toContain("result data");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Session context cache TTL
// ---------------------------------------------------------------------------

describe("session context cache TTL", () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;

  function makeSessionResponse() {
    return {
      agentInstructions: "test agent",
      platformInstructions: "test platform",
      networkInstructions: "test network",
      skillsInstructions: "test skills",
      mcpStatus: [],
      mcpTools: {},
      mcpInstructions: {},
      mcpContext: { owletto: "Check memory" },
      providerConfig: {},
      skillsConfig: [],
    };
  }

  beforeEach(() => {
    invalidateSessionContextCache();
    process.env.DISPATCHER_URL = "http://gateway:8080";
    process.env.WORKER_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    delete process.env.DISPATCHER_URL;
    delete process.env.WORKER_TOKEN;
    invalidateSessionContextCache();
  });

  test("caches result and returns it on second call", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeSessionResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const first = await getOpenClawSessionContext();
    const second = await getOpenClawSessionContext();

    expect(fetchCount).toBe(1);
    expect(first.mcpContext).toEqual({ owletto: "Check memory" });
    expect(second.mcpContext).toEqual({ owletto: "Check memory" });
  });

  test("re-fetches after cache TTL expires (5 minutes)", async () => {
    let fetchCount = 0;
    let currentTime = 1000000;
    Date.now = () => currentTime;

    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeSessionResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await getOpenClawSessionContext();
    expect(fetchCount).toBe(1);

    // Still within TTL (4 minutes later)
    currentTime += 4 * 60 * 1000;
    await getOpenClawSessionContext();
    expect(fetchCount).toBe(1);

    // Past TTL (6 minutes from original)
    currentTime += 2 * 60 * 1000;
    await getOpenClawSessionContext();
    expect(fetchCount).toBe(2);
  });

  test("invalidateSessionContextCache forces re-fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeSessionResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await getOpenClawSessionContext();
    expect(fetchCount).toBe(1);

    invalidateSessionContextCache();
    await getOpenClawSessionContext();
    expect(fetchCount).toBe(2);
  });
});
