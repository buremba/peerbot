import { describe, expect, test } from "bun:test";
import { createMcpPlugin } from "../index";

describe("MCP plugin", () => {
  test("owns discovered and authentication tools", async () => {
    const plugin = createMcpPlugin({
      gatewayUrl: "http://gateway",
      workerToken: "token",
      channelId: "channel",
      conversationId: "conversation",
      mcpTools: {
        github: [
          {
            name: "search_issues",
            description: "Search issues",
            inputSchema: { type: "object" },
          },
        ],
      },
      mcpStatus: [{ id: "github", name: "GitHub", requiresAuth: true }],
      onAuthChanged: () => undefined,
    });
    const tools = await plugin.tools!({} as never);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_issues",
      "github_login",
      "github_login_check",
      "github_logout",
    ]);
  });
});
