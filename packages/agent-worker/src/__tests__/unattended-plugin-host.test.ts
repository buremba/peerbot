/**
 * Unattended turns (today: the hidden "starters" chip generation) must not be
 * able to cause side effects. Nobody is watching them and nobody consented to
 * what they do — they fire automatically when a user opens a fresh chat.
 *
 * This is NOT expressible via `toolsConfig.allowedTools`: that gates only the
 * built-in tool set (read/bash/edit/…) and never touches plugin or MCP tools.
 * A starters turn composed the normal way was handed `send_message`,
 * `edit_message`, `delete_message` and every mutating MCP tool — an unattended
 * LLM call that could post to a real Slack. The gate therefore lives at plugin
 * COMPOSITION, where the excluded tools are never built at all.
 */

import { describe, expect, it } from "bun:test";
import { createRuntimePluginHost } from "../runtime/plugin-composition";

/**
 * The wire shape the gateway actually ships: standard MCP `annotations`, nested
 * — NOT a flat `readOnlyHint`. Lobu's own MCP server declares these (see
 * `READ_ONLY` in server/src/tools/registry.ts) and the gateway passes the
 * objects through untouched.
 */
const MCP_TOOLS = {
  lobu: [
    {
      name: "query_sdk",
      description: "read org data",
      annotations: { readOnlyHint: true },
    },
    {
      name: "search_memory",
      description: "search memory",
      annotations: { readOnlyHint: true },
    },
    {
      name: "run_sdk",
      description: "WRITES org data",
      annotations: { readOnlyHint: false },
    },
    // A server that declares no annotations at all — must be treated as
    // mutating, never silently trusted.
    { name: "legacy_unannotated", description: "unknown side effects" },
  ],
};

function baseParams(source?: string) {
  return {
    gatewayUrl: "http://gateway.invalid",
    workerToken: "token",
    channelId: "chan",
    conversationId: "conv",
    platform: "api",
    workspaceDir: "/tmp/does-not-matter",
    onCustomEvent: async () => undefined,
    onAskUserPosted: () => undefined,
    includeMcpTools: true,
    mcpTools: MCP_TOOLS,
    mcpStatus: [],
    onMcpAuthChanged: () => undefined,
    ...(source === undefined ? {} : { source }),
  } as unknown as Parameters<typeof createRuntimePluginHost>[0];
}

const ctx = {
  organizationId: "org_1",
  agentId: "lobu-builder",
  conversationId: "conv",
  destination: "chan",
  workspaceDir: "/tmp/does-not-matter",
  platform: "api",
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
} as never;

async function toolNames(source?: string): Promise<string[]> {
  const host = createRuntimePluginHost(baseParams(source));
  const tools = await host.tools(ctx);
  return tools.map((t) => (t as { name?: string }).name ?? "").sort();
}

describe("unattended (starters) plugin host", () => {
  it("never exposes conversation-mutating tools", async () => {
    const names = await toolNames("starters");
    for (const forbidden of [
      "send_message",
      "edit_message",
      "delete_message",
      "react",
      "ask_user",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("still exposes suggest_actions — the whole point of the turn", async () => {
    expect(await toolNames("starters")).toContain("suggest_actions");
  });

  it("exposes read-only MCP tools so it can inspect the org", async () => {
    const names = await toolNames("starters");
    expect(names).toContain("query_sdk");
    expect(names).toContain("search_memory");
  });

  it("excludes mutating MCP tools, and unannotated ones (fails closed)", async () => {
    const names = await toolNames("starters");
    expect(names).not.toContain("run_sdk");
    // No annotation must mean "assume it mutates" — otherwise every server that
    // declares nothing, and every newly added tool, is exposed by default.
    expect(names).not.toContain("legacy_unannotated");
  });

  it("a NORMAL turn is unaffected — it keeps messaging and write tools", async () => {
    // Guards against the gate leaking into ordinary chat: the restriction must
    // be scoped to the unattended source, not applied globally.
    const names = await toolNames();
    expect(names).toContain("send_message");
    expect(names).toContain("run_sdk");
    expect(names).toContain("legacy_unannotated");
  });
});
