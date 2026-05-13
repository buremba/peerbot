import { describe, expect, mock, test } from "bun:test";
import {
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  registerSlackAppHome,
  registerSlackPlatformHandlers,
} from "../connections/slack-platform-bridge.js";

function blocksText(view: { blocks?: Array<Record<string, unknown>> }): string {
  return JSON.stringify(view.blocks ?? []);
}

describe("Slack platform bridge", () => {
  test("routes /lobu slash commands through the command dispatcher", async () => {
    let slashHandler:
      | ((event: {
          text?: string;
          raw?: Record<string, unknown>;
          user?: { userId?: string };
          channel?: { post: (content: any) => Promise<unknown> };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onSlashCommand: mock((command: string, handler: typeof slashHandler) => {
        expect(command).toBe("/lobu");
        slashHandler = handler;
      }),
    };
    const tryHandle = mock(async () => true);

    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      { tryHandle } as any
    );

    const post = mock(async () => undefined);
    await slashHandler?.({
      text: "status now",
      raw: { channel_id: "C123", team_id: "T123", user_id: "U123" },
      user: { userId: "U123" },
      channel: { post },
    });

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("status");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("now");
    expect(tryHandle.mock.calls[0]?.[2]).toMatchObject({
      platform: "slack",
      userId: "U123",
      // Canonical `slack:<id>` form — matches the message-handler bridge's
      // thread channel id, so getBinding lookups agree across ingress paths.
      channelId: "slack:C123",
      teamId: "T123",
      isGroup: true,
      connectionId: "conn-1",
    });
  });

  test("replies when /lobu receives an unknown subcommand", async () => {
    let slashHandler:
      | ((event: {
          text?: string;
          raw?: Record<string, unknown>;
          user?: { userId?: string };
          channel?: { post: (content: any) => Promise<unknown> };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onSlashCommand: mock((_: string, handler: typeof slashHandler) => {
        slashHandler = handler;
      }),
    };
    const post = mock(async () => undefined);

    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      { tryHandle: mock(async () => false) } as any
    );

    await slashHandler?.({
      text: "unknown",
      raw: { channel_id: "D123", team_id: "T123", user_id: "U123" },
      user: { userId: "U123" },
      channel: { post },
    });

    expect(post).toHaveBeenCalledWith(
      "Unknown /lobu subcommand: unknown. Try `/lobu help`."
    );
  });

  test("publishes a Slack home tab listing the agent's integrations", async () => {
    let homeHandler:
      | ((event: {
          userId: string;
          adapter?: {
            publishHomeView?: (
              userId: string,
              view: Record<string, unknown>
            ) => Promise<void>;
          };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onAppHomeOpened: mock((handler: typeof homeHandler) => {
        homeHandler = handler;
      }),
    };
    const mcpConfigService = {
      getMcpStatus: mock(async () => [
        { id: "github", name: "github", requiresAuth: true, requiresInput: false },
        {
          id: "google-drive",
          name: "google-drive",
          requiresAuth: true,
          requiresInput: false,
        },
        { id: "weather", name: "weather", requiresAuth: false, requiresInput: false },
        {
          id: "lobu-memory",
          name: "lobu-memory",
          requiresAuth: false,
          requiresInput: false,
        },
      ]),
    };

    registerSlackAppHome(
      chat,
      {
        id: "conn-1",
        platform: "slack",
        agentId: "agent-7",
        metadata: { botUsername: "Lobster" },
        settings: {},
      } as any,
      mcpConfigService as any
    );

    const publishHomeView = mock(async () => undefined);
    await homeHandler?.({ userId: "U123", adapter: { publishHomeView } });

    expect(publishHomeView).toHaveBeenCalledTimes(1);
    const [userId, view] = publishHomeView.mock.calls[0]!;
    expect(userId).toBe("U123");
    expect((view as { type: string }).type).toBe("home");
    const text = blocksText(view as { blocks?: Array<Record<string, unknown>> });
    expect(text).toContain("Lobster");
    expect(text).toContain("Github — sign-in required");
    expect(text).toContain("Google Drive — sign-in required");
    expect(text).toContain("• Weather");
    // Internal plumbing MCP is hidden from the home tab.
    expect(text).not.toContain("Lobu Memory");
    expect(text).toContain("/lobu help");
  });

  test("shows an empty-integrations home tab when the agent has none", async () => {
    let homeHandler:
      | ((event: {
          userId: string;
          adapter?: {
            publishHomeView?: (
              userId: string,
              view: Record<string, unknown>
            ) => Promise<void>;
          };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onAppHomeOpened: mock((handler: typeof homeHandler) => {
        homeHandler = handler;
      }),
    };

    registerSlackAppHome(
      chat,
      {
        id: "conn-1",
        platform: "slack",
        agentId: "agent-7",
        metadata: {},
        settings: {},
      } as any,
      { getMcpStatus: mock(async () => []) } as any
    );

    const publishHomeView = mock(async () => undefined);
    await homeHandler?.({ userId: "U123", adapter: { publishHomeView } });

    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    expect(text).toContain("No integrations connected yet");
  });

  test("renders the preview-workspace home tab without touching agent settings", async () => {
    let homeHandler:
      | ((event: {
          userId: string;
          adapter?: {
            publishHomeView?: (
              userId: string,
              view: Record<string, unknown>
            ) => Promise<void>;
          };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onAppHomeOpened: mock((handler: typeof homeHandler) => {
        homeHandler = handler;
      }),
    };
    const getMcpStatus = mock(async () => []);

    registerSlackAppHome(
      chat,
      {
        id: "conn-1",
        platform: "slack",
        agentId: "placeholder",
        metadata: {},
        settings: { previewMode: true },
      } as any,
      { getMcpStatus } as any
    );

    const publishHomeView = mock(async () => undefined);
    await homeHandler?.({ userId: "U123", adapter: { publishHomeView } });

    expect(getMcpStatus).not.toHaveBeenCalled();
    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    expect(text).toContain("preview");
    expect(text).toContain("/lobu link");
  });

  test("parses and welcomes Slack team_join users", async () => {
    const parsed = parseSlackTeamJoinEvent(
      JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "team_join",
          user: {
            id: "U123",
            profile: { display_name: "Ada" },
          },
        },
      }),
      "application/json"
    );

    expect(parsed).toEqual({
      teamId: "T123",
      userId: "U123",
      displayName: "Ada",
    });

    const post = mock(async () => undefined);
    const chat = {
      openDM: mock(async (userId: string) => {
        expect(userId).toBe("U123");
        return { post };
      }),
    };

    await postSlackTeamJoinWelcome(chat, parsed!);

    expect(post).toHaveBeenCalledWith(
      "Welcome to Lobu, Ada. Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands."
    );
  });
});
