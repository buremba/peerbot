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
  test("preserves explicit composition order and composes prompt context", async () => {
    const host = new PluginHost([
      plugin("zeta", {
        beforeAgentStart: () => ({ prependContext: "zeta" }),
      }),
      plugin("alpha", {
        beforeAgentStart: () => ({ prependContext: "alpha" }),
      }),
    ]);

    expect(host.plugins.map((entry) => entry.manifest.name)).toEqual([
      "zeta",
      "alpha",
    ]);
    expect(
      await host.beforeAgentStart({ prompt: "hello", messages: [] }, context)
    ).toEqual(["zeta", "alpha"]);
  });

  test("rejects duplicate plugin names", () => {
    expect(() => new PluginHost([plugin("same"), plugin("same")])).toThrow(
      "Duplicate Lobu plugin"
    );
  });

  test("rejects duplicate named contributions", async () => {
    const host = new PluginHost<{ name: string }>([
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
    ]);

    await expect(host.tools(context)).rejects.toThrow(
      "Duplicate Lobu plugin tool: shared"
    );
  });
});
