import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlugins,
  wrapToolsWithPluginToolHooks,
} from "../openclaw/plugin-loader";

type ToolArg = Parameters<typeof wrapToolsWithPluginToolHooks>[0][number];
type PluginArg = Parameters<typeof wrapToolsWithPluginToolHooks>[1][number];
type Handler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>
) => unknown;

function fakePlugin(hooks: {
  before_tool_call?: Handler[];
  after_tool_call?: Handler[];
}): PluginArg {
  return {
    hooks: {
      before_agent_start: [],
      agent_end: [],
      before_tool_call: hooks.before_tool_call ?? [],
      after_tool_call: hooks.after_tool_call ?? [],
    },
  } as unknown as PluginArg;
}

/** Echoes the params it was executed with back into the result content. */
function echoTool(name: string, onExecute?: () => void): ToolArg {
  return {
    name,
    label: name,
    description: "fake echo tool",
    parameters: { type: "object", properties: {} },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      onExecute?.();
      return {
        content: [{ type: "text", text: JSON.stringify(params) }],
        details: undefined,
      };
    },
  } as unknown as ToolArg;
}

async function runTool(
  tool: ToolArg,
  params: Record<string, unknown>
): Promise<{ content: Array<{ text?: string }>; details: unknown }> {
  const exec = tool.execute as unknown as (
    id: string,
    p: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined
  ) => Promise<{ content: Array<{ text?: string }>; details: unknown }>;
  return exec("call-1", params, undefined, undefined, undefined);
}

describe("wrapToolsWithPluginToolHooks", () => {
  test("returns the original array unchanged when no tool hooks registered", () => {
    const tools = [echoTool("echo")];
    const wrapped = wrapToolsWithPluginToolHooks(tools, [fakePlugin({})], {});
    expect(wrapped).toBe(tools);
  });

  test("block prevents execution and returns the block reason to the agent", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo", () => (executed = true))],
      [
        fakePlugin({
          before_tool_call: [() => ({ block: true, blockReason: "nope" })],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, { a: 1 });
    expect(executed).toBe(false);
    expect(result.content[0].text).toContain("nope");
  });

  test("params returned by a hook are merged into the tool args", async () => {
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo")],
      [fakePlugin({ before_tool_call: [() => ({ params: { b: 2 } })] })],
      {}
    );

    const result = await runTool(wrapped, { a: 1 });
    expect(JSON.parse(result.content[0].text ?? "{}")).toEqual({ a: 1, b: 2 });
  });

  test("passes through when a hook returns no decision", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo", () => (executed = true))],
      [fakePlugin({ before_tool_call: [() => undefined] })],
      {}
    );

    const result = await runTool(wrapped, { a: 1 });
    expect(executed).toBe(true);
    expect(JSON.parse(result.content[0].text ?? "{}")).toEqual({ a: 1 });
  });

  test("fails closed: a throwing hook blocks the call", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo", () => (executed = true))],
      [
        fakePlugin({
          before_tool_call: [
            () => {
              throw new Error("boom");
            },
          ],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, {});
    expect(executed).toBe(false);
    expect(result.content[0].text).toContain("boom");
  });

  test("requireApproval maps to a soft block using the description", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo", () => (executed = true))],
      [
        fakePlugin({
          before_tool_call: [
            () => ({
              requireApproval: { title: "T", description: "needs ok" },
            }),
          ],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, {});
    expect(executed).toBe(false);
    expect(result.content[0].text).toContain("needs ok");
  });

  test("block takes precedence over a prior requireApproval", async () => {
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo")],
      [
        fakePlugin({
          before_tool_call: [
            () => ({ requireApproval: { description: "approve me" } }),
            () => ({ block: true, blockReason: "hard block" }),
          ],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, {});
    expect(result.content[0].text).toContain("hard block");
    expect(result.content[0].text).not.toContain("approve me");
  });

  test("wraps a tool whose execute takes only 4 args (no trailing ctx)", async () => {
    // AgentTool-shaped tools have a 4-arg execute; the wrapper must still block
    // them correctly (it passes a 5th arg, which is harmless).
    let executed = false;
    const fourArgTool = {
      name: "echo",
      label: "echo",
      description: "4-arg execute tool",
      parameters: { type: "object", properties: {} },
      execute: async (_id: string, params: Record<string, unknown>) => {
        executed = true;
        return {
          content: [{ type: "text", text: JSON.stringify(params) }],
          details: undefined,
        };
      },
    } as unknown as ToolArg;

    const [wrapped] = wrapToolsWithPluginToolHooks(
      [fourArgTool],
      [
        fakePlugin({
          before_tool_call: [() => ({ block: true, blockReason: "blocked" })],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, { command: "x" });
    expect(executed).toBe(false);
    expect(result.content[0].text).toContain("blocked");
  });

  test("after_tool_call fires (detached) with the execution result", async () => {
    let resolveSeen!: (value: unknown) => void;
    const seen = new Promise<unknown>((resolve) => {
      resolveSeen = resolve;
    });
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo")],
      [
        fakePlugin({
          after_tool_call: [(event) => resolveSeen(event.result)],
        }),
      ],
      {}
    );

    await runTool(wrapped, { a: 1 });
    const seenResult = await seen; // detached handler runs after the tool returns
    expect(
      (seenResult as { content: Array<{ text?: string }> }).content[0].text
    ).toContain('"a":1');
  });

  test("a synchronously throwing after_tool_call does not fail the tool", async () => {
    // after_tool_call is fire-and-forget: a throwing handler must not reject a
    // tool that already executed successfully.
    const [wrapped] = wrapToolsWithPluginToolHooks(
      [echoTool("echo")],
      [
        fakePlugin({
          after_tool_call: [
            () => {
              throw new Error("after boom");
            },
          ],
        }),
      ],
      {}
    );

    const result = await runTool(wrapped, { a: 1 });
    expect(JSON.parse(result.content[0].text ?? "{}")).toEqual({ a: 1 });
  });
});

describe("loadPlugins captures before_tool_call via the shim on()", () => {
  test("an object-style plugin registering a before_tool_call hook loads and gates its tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-plugin-"));
    const modPath = join(dir, "gate-plugin.mjs");
    writeFileSync(
      modPath,
      `export default {
        name: "gate-plugin",
        register(api) {
          api.registerTool({
            name: "echo",
            label: "echo",
            description: "echo tool",
            parameters: { type: "object", properties: {} },
            execute: async (_id, params) => ({
              content: [{ type: "text", text: JSON.stringify(params) }],
              details: undefined,
            }),
          });
          api.on("before_tool_call", (event) =>
            event.params && event.params.deny ? { block: true, blockReason: "denied" } : undefined
          );
        },
      };`
    );

    const loaded = await loadPlugins({
      plugins: [{ source: modPath, slot: "tool" }],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].tools).toHaveLength(1);
    expect(loaded[0].hooks.before_tool_call).toHaveLength(1);

    const [wrapped] = wrapToolsWithPluginToolHooks(
      loaded[0].tools as unknown as ToolArg[],
      loaded as unknown as PluginArg[],
      {}
    );

    const blocked = await runTool(wrapped, { deny: true });
    expect(blocked.content[0].text).toContain("denied");

    const allowed = await runTool(wrapped, { deny: false });
    expect(JSON.parse(allowed.content[0].text ?? "{}")).toEqual({
      deny: false,
    });
  });
});
