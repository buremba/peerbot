import { describe, expect, test } from "bun:test";
import {
  defineLobuPlugin,
  LOBU_PLUGIN_API_VERSION,
  type PluginLogger,
  type PluginRuntimeContext,
} from "@lobu/plugin-api";
import { PluginHost } from "../index";

const logger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const context: PluginRuntimeContext = {
  organizationId: "org-1",
  actorId: "user-1",
  credentialSubject: "user-1",
  destination: "channel-1",
  agentId: "agent-1",
  conversationId: "conversation-1",
  runId: 1,
  messageId: "message-1",
  workspaceDir: "/workspace",
  platform: "slack",
  logger,
};

function plugin(
  name: string,
  hooks: Parameters<typeof defineLobuPlugin>[0]["hooks"] = {}
) {
  return defineLobuPlugin({
    manifest: {
      name,
      version: "1.0.0",
      apiVersion: LOBU_PLUGIN_API_VERSION,
      description: `${name} plugin`,
    },
    hooks,
  });
}

describe("PluginHost", () => {
  test("orders plugins deterministically and composes prompt context", async () => {
    const host = new PluginHost(
      [
        plugin("zeta", {
          beforeAgentStart: () => ({ prependContext: "zeta" }),
        }),
        plugin("alpha", {
          beforeAgentStart: () => ({ prependContext: "alpha" }),
        }),
      ],
      new Set()
    );

    expect(host.plugins.map((entry) => entry.manifest.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(
      await host.beforeAgentStart({ prompt: "hello", messages: [] }, context)
    ).toEqual(["alpha", "zeta"]);
  });

  test("fails closed when a pre-tool hook throws", async () => {
    const host = new PluginHost(
      [
        plugin("policy", {
          beforeToolCall: () => {
            throw new Error("policy unavailable");
          },
        }),
      ],
      new Set()
    );

    const result = await host.beforeToolCall(
      { toolName: "bash", toolCallId: "call-1", params: {} },
      context
    );
    expect(result.blockReason).toContain("failed closed");
  });

  test("rejects duplicate names and missing capabilities", () => {
    expect(
      () => new PluginHost([plugin("same"), plugin("same")], new Set())
    ).toThrow("Duplicate Lobu plugin");

    const requiring = defineLobuPlugin({
      manifest: {
        name: "requiring",
        version: "1.0.0",
        apiVersion: LOBU_PLUGIN_API_VERSION,
        description: "requires memory",
        capabilities: ["memory.read"],
      },
    });
    expect(() => new PluginHost([requiring], new Set())).toThrow(
      "requires unavailable capabilities"
    );
  });

  test("rejects duplicate named contributions", async () => {
    const host = new PluginHost<{ name: string }>(
      [
        defineLobuPlugin({
          manifest: {
            name: "alpha",
            version: "1.0.0",
            apiVersion: LOBU_PLUGIN_API_VERSION,
            description: "alpha plugin",
          },
          tools: () => [{ name: "shared" }],
        }),
        defineLobuPlugin({
          manifest: {
            name: "beta",
            version: "1.0.0",
            apiVersion: LOBU_PLUGIN_API_VERSION,
            description: "beta plugin",
          },
          tools: () => [{ name: "shared" }],
        }),
      ],
      new Set()
    );

    await expect(host.tools(context)).rejects.toThrow(
      "Duplicate Lobu plugin tool: shared"
    );
  });

  test("rolls back started services when a later service fails", async () => {
    const calls: string[] = [];
    const host = new PluginHost(
      [
        defineLobuPlugin({
          manifest: {
            name: "services",
            version: "1.0.0",
            apiVersion: LOBU_PLUGIN_API_VERSION,
            description: "service lifecycle plugin",
          },
          services: [
            {
              id: "first",
              start: () => {
                calls.push("start:first");
              },
              stop: () => {
                calls.push("stop:first");
              },
            },
            {
              id: "second",
              start: () => {
                calls.push("start:second");
                throw new Error("start failed");
              },
              stop: () => {
                calls.push("stop:second");
              },
            },
          ],
        }),
      ],
      new Set()
    );

    await expect(host.start(context)).rejects.toThrow("start failed");
    expect(calls).toEqual(["start:first", "start:second", "stop:first"]);
  });
});
