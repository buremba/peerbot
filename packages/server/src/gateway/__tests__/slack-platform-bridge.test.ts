import { describe, expect, mock, test } from "bun:test";

// Stub the MCP OAuth flow so the home-tab "Connect" path doesn't hit the
// network for discovery. Must be registered before slack-platform-bridge is
// imported (it captures the `startAuthCodeFlow` binding at module eval).
const startAuthCodeFlowMock = mock(async (opts: any) => ({
  authorizationUrl: `${opts?.staticOauth?.authUrl ?? "https://auth.example/authorize"}?state=test-state`,
  state: "test-state",
}));
mock.module("../auth/mcp/oauth-flow.js", () => ({
  startAuthCodeFlow: startAuthCodeFlowMock,
}));

import {
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  registerSlackAppHome,
  registerSlackPlatformHandlers,
} from "../connections/slack-platform-bridge.js";

function blocksText(view: { blocks?: Array<Record<string, unknown>> }): string {
  return JSON.stringify(view.blocks ?? []);
}

type HomeHandler = (event: {
  userId: string;
  adapter?: {
    publishHomeView?: (u: string, v: Record<string, unknown>) => Promise<void>;
  };
}) => Promise<void>;
type ActionHandler = (event: {
  actionId: string;
  value?: string;
  user: { userId: string };
  adapter?: {
    publishHomeView?: (u: string, v: Record<string, unknown>) => Promise<void>;
  };
  raw?: unknown;
}) => Promise<void>;

function makeHomeChat() {
  let homeHandler: HomeHandler | undefined;
  let actionHandler: ActionHandler | undefined;
  const chat = {
    onAppHomeOpened: mock((h: HomeHandler) => {
      homeHandler = h;
    }),
    onAction: mock((_ids: string[], h: ActionHandler) => {
      actionHandler = h;
    }),
  };
  return {
    chat,
    open: (userId: string, publishHomeView: ReturnType<typeof mock>) =>
      homeHandler?.({ userId, adapter: { publishHomeView } }),
    click: (
      actionId: string,
      value: string,
      userId: string,
      publishHomeView: ReturnType<typeof mock>
    ) =>
      actionHandler?.({
        actionId,
        value,
        user: { userId },
        adapter: { publishHomeView },
      }),
  };
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

  const connection = (over: Record<string, unknown> = {}) =>
    ({
      id: "conn-1",
      platform: "slack",
      agentId: "agent-7",
      organizationId: "org-test",
      metadata: { botUsername: "Lobster" },
      settings: {},
      ...over,
    }) as any;

  const mcpStatus = [
    { id: "github", name: "github", requiresAuth: true, requiresInput: false },
    {
      id: "google-drive",
      name: "google-drive",
      requiresAuth: true,
      requiresInput: false,
    },
    {
      id: "weather",
      name: "weather",
      requiresAuth: false,
      requiresInput: false,
    },
    {
      id: "lobu-memory",
      name: "lobu-memory",
      requiresAuth: false,
      requiresInput: false,
    },
  ];

  // Fake WritableSecretStore: GitHub has a stored credential, nothing else.
  const fakeSecretStore = () => {
    const del = mock(async (_name: string) => undefined);
    return {
      del,
      store: {
        get: mock(async (ref: string) =>
          ref.includes("github") ? JSON.stringify({ accessToken: "x" }) : null
        ),
        put: mock(async () => "secret://x"),
        delete: del,
        list: mock(async () => []),
      } as any,
    };
  };

  test("home tab shows per-user connect/disconnect status for integrations", async () => {
    const h = makeHomeChat();
    const { store } = fakeSecretStore();
    registerSlackAppHome(h.chat, connection(), {
      mcpConfigService: { getMcpStatus: mock(async () => mcpStatus) } as any,
      secretStore: store,
      publicGatewayUrl: "https://gw.example",
    });

    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    expect(publishHomeView).toHaveBeenCalledTimes(1);
    const view = publishHomeView.mock.calls[0]![1] as {
      type: string;
      blocks: Array<Record<string, any>>;
    };
    expect(view.type).toBe("home");
    const text = blocksText(view);
    expect(text).toContain("Lobster");
    expect(text).toContain("Github");
    expect(text).toContain("Google Drive");
    expect(text).toContain("Weather");
    // Internal plumbing MCP is hidden.
    expect(text).not.toContain("Lobu Memory");

    // GitHub has a credential → Disconnect button.
    const githubSection = view.blocks.find(
      (b) => b.accessory?.value === "github"
    );
    expect(githubSection?.accessory?.action_id).toBe("lobu_home_disconnect");
    // Google Drive is not connected → Connect button.
    const gdriveSection = view.blocks.find(
      (b) => b.accessory?.value === "google-drive"
    );
    expect(gdriveSection?.accessory?.action_id).toBe("lobu_home_connect");
  });

  test("Disconnect button revokes the credential and re-publishes the home tab", async () => {
    const h = makeHomeChat();
    const { store, del } = fakeSecretStore();
    registerSlackAppHome(h.chat, connection(), {
      mcpConfigService: { getMcpStatus: mock(async () => mcpStatus) } as any,
      secretStore: store,
      publicGatewayUrl: "https://gw.example",
    });

    const publishHomeView = mock(async () => undefined);
    await h.click("lobu_home_disconnect", "github", "U123", publishHomeView);

    // deleteCredential removes both the credential and device-auth secret rows.
    expect(del).toHaveBeenCalled();
    expect(del.mock.calls.some(([name]) => String(name).includes("github"))).toBe(
      true
    );
    expect(publishHomeView).toHaveBeenCalledTimes(1);
    expect(publishHomeView.mock.calls[0]![0]).toBe("U123");
  });

  test("ignores a Disconnect action for an integration the agent doesn't have", async () => {
    const h = makeHomeChat();
    const { store, del } = fakeSecretStore();
    registerSlackAppHome(h.chat, connection(), {
      mcpConfigService: { getMcpStatus: mock(async () => mcpStatus) } as any,
      secretStore: store,
      publicGatewayUrl: "https://gw.example",
    });

    const publishHomeView = mock(async () => undefined);
    await h.click(
      "lobu_home_disconnect",
      "../../other-agent/U999/github/credential",
      "U123",
      publishHomeView
    );

    // No secret deleted, no home re-publish — the crafted id is rejected.
    expect(del).not.toHaveBeenCalled();
    expect(publishHomeView).not.toHaveBeenCalled();
  });

  test("Connect button mints an auth URL and re-publishes with a sign-in link", async () => {
    const h = makeHomeChat();
    startAuthCodeFlowMock.mockClear();
    const getHttpServer = mock(async () => ({
      id: "github",
      upstreamUrl: "https://github-mcp.example/mcp",
      oauth: {
        authUrl: "https://github-mcp.example/oauth/authorize",
        tokenUrl: "https://github-mcp.example/oauth/token",
        clientId: "client-123",
      },
    }));
    registerSlackAppHome(h.chat, connection(), {
      mcpConfigService: {
        getMcpStatus: mock(async () => mcpStatus),
        getHttpServer,
      } as any,
      secretStore: { get: mock(async () => null), put: mock(), delete: mock(), list: mock(async () => []) } as any,
      publicGatewayUrl: "https://gw.example",
    });

    const publishHomeView = mock(async () => undefined);
    await h.click("lobu_home_connect", "github", "U123", publishHomeView);

    expect(getHttpServer).toHaveBeenCalled();
    expect(startAuthCodeFlowMock).toHaveBeenCalledTimes(1);
    const flowOpts = startAuthCodeFlowMock.mock.calls[0]![0] as any;
    expect(flowOpts.mcpId).toBe("github");
    expect(flowOpts.scopeKey).toBe("U123");
    expect(flowOpts.platform).toBe("slack");

    expect(publishHomeView).toHaveBeenCalledTimes(1);
    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, any>>;
    };
    const githubSection = view.blocks.find((b) =>
      String(b.text?.text ?? "").includes("Github")
    );
    expect(githubSection?.accessory?.url).toContain(
      "https://github-mcp.example/oauth/authorize"
    );
    expect(githubSection?.accessory?.url).toContain("state=test-state");
  });

  test("home tab renders without the integrations section when the MCP config service is absent", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {});
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(blocksText(view)).toContain("Lobster");
    expect(view.blocks.some((b) => b.type === "header")).toBe(false);
  });

  test("home tab renders the dashboard card with a slug deep link and org counts", async () => {
    const h = makeHomeChat();
    const resolveHomeContext = mock(async () => ({
      orgSlug: "acme",
      entitiesTracked: 976,
      capturedToday: 5,
      recent: [
        { title: "Acme raised a Series B", platform: "gmail", ts: 1_700_000_000 },
        { title: "Standup notes", platform: null, ts: 1_700_000_100 },
      ],
    }));
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example/",
      resolveHomeContext,
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    expect(resolveHomeContext).toHaveBeenCalledWith("org-test");
    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    // Deep link uses the org slug, trailing slash trimmed.
    expect(text).toContain("https://gw.example/acme");
    expect(text).toContain("Open dashboard");
    // Counts render as a context line.
    expect(text).toContain("976 tracked");
    expect(text).toContain("5 captured today");
    // Recent activity list renders with a source label and a Slack date token.
    expect(text).toContain("Recent activity");
    expect(text).toContain("Acme raised a Series B");
    expect(text).toContain("Gmail");
    expect(text).toContain("<!date^1700000000");
  });

  test("recent titles are escaped and the list is skipped when empty", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveHomeContext: mock(async () => ({
        orgSlug: "acme",
        entitiesTracked: 1,
        capturedToday: 0,
        recent: [{ title: "<script>&", platform: null, ts: 1 }],
      })),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Recent activity");
    // mrkdwn control chars escaped, JSON-encoded in the serialized blocks.
    expect(text).toContain("&lt;script&gt;&amp;");
    expect(text).not.toContain("<script>");
  });

  test("dashboard card links to the web root and omits counts when context is unavailable", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveHomeContext: mock(async () => null),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, unknown>>;
    };
    const text = blocksText(view);
    expect(text).toContain('"url":"https://gw.example"');
    expect(text).toContain("Open dashboard");
    // No counts line, and no crash on a null context.
    expect(view.blocks.some((b) => b.type === "context")).toBe(false);
  });

  test("dashboard card is skipped without a public gateway url", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      resolveHomeContext: mock(async () => ({
        orgSlug: "acme",
        entitiesTracked: 1,
        capturedToday: 1,
        recent: [],
      })),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Open dashboard"
    );
  });

  test("preview workspaces don't render the dashboard card", async () => {
    const h = makeHomeChat();
    const resolveHomeContext = mock(async () => ({
      orgSlug: "acme",
      entitiesTracked: 1,
      capturedToday: 1,
      recent: [],
    }));
    registerSlackAppHome(
      h.chat,
      connection({ settings: { previewMode: true } }),
      { publicGatewayUrl: "https://gw.example", resolveHomeContext }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(resolveHomeContext).not.toHaveBeenCalled();
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Open dashboard"
    );
  });

  test("renders personal notifications with absolute links and an unread count", async () => {
    const h = makeHomeChat();
    const resolveUserInbox = mock(async () => ({
      unreadCount: 2,
      orgSlug: "acme",
      items: [
        { title: "Series B closed", url: "/acme/companies/1", isRead: false },
        { title: "Synced", url: "https://x.test/full", isRead: true },
        { title: "No link", url: null, isRead: true },
      ],
    }));
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example/",
      resolveUserInbox,
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    // resolveUserInbox is called with (slackUserId, teamId). The connection()
    // helper has no metadata.teamId, so teamId falls back to '' (preview/unknown).
    expect(resolveUserInbox).toHaveBeenCalledWith("U123", "");
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Notifications");
    expect(text).toContain("2 unread");
    // relative resource_url made absolute against the web origin
    expect(text).toContain("<https://gw.example/acme/companies/1|Series B closed>");
    // already-absolute url left as-is
    expect(text).toContain("<https://x.test/full|Synced>");
    // unread vs read markers present
    expect(text).toContain(":large_blue_circle:");
    expect(text).toContain(":white_circle:");
  });

  test("passes the connection team_id to resolveUserInbox for workspace installs", async () => {
    const h = makeHomeChat();
    const resolveUserInbox = mock(async () => null);
    registerSlackAppHome(
      h.chat,
      connection({ metadata: { botUsername: "Lobster", teamId: "T_WORKSPACE" } }),
      { publicGatewayUrl: "https://gw.example/", resolveUserInbox },
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    // Must be scoped to the connection's workspace — a different workspace's
    // identity row with the same platform_user_id must NOT be returned.
    expect(resolveUserInbox).toHaveBeenCalledWith("U123", "T_WORKSPACE");
  });

  test("omits the notifications section when the user has no linked inbox", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveUserInbox: mock(async () => null),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Notifications"
    );
  });

  test("preview home shows a 'Set up your agent' button plus the link-code hint", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(
      h.chat,
      connection({ settings: { previewMode: true } }),
      { publicGatewayUrl: "https://gw.example/" }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Set up your agent");
    // No resolved identity → no org → setup button points at the web root.
    expect(text).toContain('"url":"https://gw.example"');
    expect(text).toContain("/lobu link");
  });

  test("preview setup button deep-links to the user's org home when known", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(
      h.chat,
      connection({ settings: { previewMode: true } }),
      {
        publicGatewayUrl: "https://gw.example",
        resolveUserInbox: mock(async () => ({
          unreadCount: 0,
          orgSlug: "acme",
          items: [],
        })),
      }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    // /{org} (the Builder home), NOT /{org}/agents — the latter redirects.
    expect(text).toContain('"url":"https://gw.example/acme"');
  });

  test("falls back to a minimal home view if the rich view is rejected", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {});
    let calls = 0;
    const publishHomeView = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("invalid_blocks");
    });
    await h.open("U123", publishHomeView);
    expect(publishHomeView).toHaveBeenCalledTimes(2);
    const fallback = publishHomeView.mock.calls[1]![1] as {
      type: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(fallback.type).toBe("home");
    expect(fallback.blocks.length).toBe(1);
    expect(blocksText(fallback)).toContain("/lobu help");
  });

  test("renders the preview-workspace home tab without touching the MCP config", async () => {
    const h = makeHomeChat();
    const getMcpStatus = mock(async () => mcpStatus);
    registerSlackAppHome(
      h.chat,
      connection({ agentId: "placeholder", settings: { previewMode: true } }),
      {
        mcpConfigService: { getMcpStatus } as any,
        secretStore: { getStoredCredential: mock(async () => null) } as any,
        publicGatewayUrl: "https://gw.example",
      }
    );

    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    expect(getMcpStatus).not.toHaveBeenCalled();
    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    expect(text).toContain("Set up your agent");
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
