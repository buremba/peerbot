import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpToolDef } from "@lobu/core";
import {
  buildMcpCliCommands,
  type McpCliDeps,
  type McpRuntimeRef,
} from "../embedded/mcp-cli-commands";
import type { GatewayParams } from "../shared/tool-implementations";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "worker-token",
  channelId: "channel-1",
  conversationId: "conversation-1",
  platform: "telegram",
};

const searchKnowledge: McpToolDef = {
  name: "search_knowledge",
  description: "Search memory",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

async function buildBash(options: {
  ref: McpRuntimeRef;
  callTool: (
    mcpId: string,
    toolName: string,
    payload: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}) {
  const { Bash, ReadWriteFs, defineCommand } = await import("just-bash");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lobu-mcp-cli-"));
  tempDirs.push(tmp);

  const callTool: McpCliDeps["callTool"] = async (
    _gw,
    mcpId,
    toolName,
    payload
  ) => options.callTool(mcpId, toolName, payload);

  const cliCommands = buildMcpCliCommands(options.ref, gw, { callTool });

  const customCommands = cliCommands.map((c) =>
    defineCommand(c.name, async (args: string[], ctx) => {
      return c.execute(args, {
        stdin: typeof ctx.stdin === "string" ? ctx.stdin : "",
      });
    })
  );

  const bash = new Bash({
    fs: new ReadWriteFs({ root: tmp }),
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    customCommands,
  });

  return bash;
}

describe("embedded MCP CLI through real just-bash", () => {
  test("heredoc JSON on stdin reaches the handler as a parsed object", async () => {
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: { owletto: [searchKnowledge] },
        mcpStatus: [],
        mcpContext: {},
      },
    };
    const calls: Array<{ payload: Record<string, unknown> }> = [];
    const bash = await buildBash({
      ref,
      callTool: async (_mcpId, _toolName, payload) => {
        calls.push({ payload });
        return { content: [{ type: "text", text: "hit" }] };
      },
    });

    const result = await bash.exec(
      `owletto search_knowledge <<'EOF'
{"query":"architecture"}
EOF`,
      { cwd: "/" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hit");
    expect(calls).toEqual([{ payload: { query: "architecture" } }]);
  });

  test("echo … | <server> <tool> routes the piped JSON into the handler", async () => {
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: { owletto: [searchKnowledge] },
        mcpStatus: [],
        mcpContext: {},
      },
    };
    const calls: Array<{ payload: Record<string, unknown> }> = [];
    const bash = await buildBash({
      ref,
      callTool: async (_mcpId, _toolName, payload) => {
        calls.push({ payload });
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    const result = await bash.exec(
      `echo '{"query":"piped"}' | owletto search_knowledge`,
      { cwd: "/" }
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ payload: { query: "piped" } }]);
  });

  test("<server> --help lists the discovered tools", async () => {
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: { owletto: [searchKnowledge] },
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
        mcpContext: {},
      },
    };
    const bash = await buildBash({
      ref,
      callTool: async () => ({ content: [] }),
    });

    const result = await bash.exec("owletto --help", { cwd: "/" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("search_knowledge");
    expect(result.stdout).toContain("auth login|check|logout");
  });

  test("unknown subcommand exits with stderr diagnostic", async () => {
    const ref: McpRuntimeRef = {
      current: {
        mcpTools: { owletto: [] },
        mcpStatus: [],
        mcpContext: {},
      },
    };
    const bash = await buildBash({
      ref,
      callTool: async () => ({ content: [] }),
    });

    const result = await bash.exec("owletto mystery", { cwd: "/" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown tool");
  });
});
