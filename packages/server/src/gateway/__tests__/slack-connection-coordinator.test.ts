import { describe, expect, mock, test } from "bun:test";
import { SlackConnectionCoordinator } from "../connections/slack-connection-coordinator.js";
import type { PlatformConnection } from "../connections/types.js";

function createSlackConnection(
  id: string,
  metadata: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
): PlatformConnection {
  return {
    id,
    platform: "slack",
    templateAgentId: "template",
    config: {
      platform: "slack",
      signingSecret: "signing-secret",
      clientId: "client-id",
      clientSecret: "client-secret",
      ...config,
    } as any,
    settings: { allowGroups: true },
    metadata,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("SlackConnectionCoordinator", () => {
  test("ensureWorkspaceConnection is idempotent per team", async () => {
    const connections: PlatformConnection[] = [];
    const addConnection = mock(
      async (
        _platform: string,
        templateAgentId: string | undefined,
        config: any,
        settings?: { allowGroups?: boolean },
        metadata?: Record<string, unknown>
      ) => {
        const connection = createSlackConnection("conn-1", metadata, config);
        connection.templateAgentId = templateAgentId;
        connection.settings = settings || { allowGroups: true };
        connections.push(connection);
        return connection;
      }
    );
    const updateConnection = mock(
      async (connectionId: string, updates: Partial<PlatformConnection>) => {
        const connection = connections.find(
          (item) => item.id === connectionId
        )!;
        Object.assign(connection, updates);
        return connection;
      }
    );
    const restartConnection = mock(async () => undefined);

    const coordinator = new SlackConnectionCoordinator({
      addConnection,
      createStateAdapter: mock(async () => ({})),
      ensureConnectionRunning: mock(async () => true),
      forwardWebhook: mock(async () => new Response("ok")),
      getCurrentSlackConfig: () => ({
        signingSecret: "signing-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      getRunningChat: () => undefined,
      hasConnection: () => false,
      listSlackConnections: async () => connections,
      restartConnection,
      updateConnection,
    });

    const first = await coordinator.ensureWorkspaceConnection("T123", {
      botToken: "xoxb-first-token",
      botUserId: "U123",
      teamName: "Acme",
    });
    const second = await coordinator.ensureWorkspaceConnection("T123", {
      botToken: "xoxb-second-token",
      botUserId: "U456",
      teamName: "Acme Updated",
    });

    expect(first.id).toBe("conn-1");
    expect(second.id).toBe("conn-1");
    expect(addConnection).toHaveBeenCalledTimes(1);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    expect(restartConnection).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.metadata).toEqual({
      teamId: "T123",
      teamName: "Acme Updated",
      botUserId: "U456",
    });
    expect((connections[0]?.config as any).botToken).toBe("xoxb-second-token");
  });

  test("handleAppWebhook prefers an exact team match", async () => {
    const body = JSON.stringify({ team_id: "T123", type: "event_callback" });
    const coordinator = new SlackConnectionCoordinator({
      addConnection: mock(async () => createSlackConnection("unused")),
      createStateAdapter: mock(async () => ({})),
      ensureConnectionRunning: mock(async () => true),
      forwardWebhook: mock(async (connectionId: string, request: Request) => {
        return new Response(`${connectionId}:${await request.text()}`);
      }),
      getCurrentSlackConfig: () => ({
        signingSecret: "signing-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      getRunningChat: () => undefined,
      hasConnection: () => true,
      listSlackConnections: async () => [
        createSlackConnection("conn-team", { teamId: "T123" }),
        createSlackConnection("conn-default"),
      ],
      restartConnection: mock(async () => undefined),
      updateConnection: mock(async () => createSlackConnection("unused")),
    });

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`conn-team:${body}`);
  });

  test("handleAppWebhook falls back to the default Slack connection", async () => {
    const body = JSON.stringify({ type: "url_verification" });
    const coordinator = new SlackConnectionCoordinator({
      addConnection: mock(async () => createSlackConnection("unused")),
      createStateAdapter: mock(async () => ({})),
      ensureConnectionRunning: mock(async () => true),
      forwardWebhook: mock(async (connectionId: string, request: Request) => {
        return new Response(`${connectionId}:${await request.text()}`);
      }),
      getCurrentSlackConfig: () => ({
        signingSecret: "signing-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      getRunningChat: () => undefined,
      hasConnection: () => true,
      listSlackConnections: async () => [createSlackConnection("conn-default")],
      restartConnection: mock(async () => undefined),
      updateConnection: mock(async () => createSlackConnection("unused")),
    });

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`conn-default:${body}`);
  });

  test("handleAppWebhook sends a welcome DM for team_join events", async () => {
    const post = mock(async () => undefined);
    const openDM = mock(async () => ({ post }));
    const coordinator = new SlackConnectionCoordinator({
      addConnection: mock(async () => createSlackConnection("unused")),
      createStateAdapter: mock(async () => ({})),
      ensureConnectionRunning: mock(async () => true),
      forwardWebhook: mock(async () => new Response("ok")),
      getCurrentSlackConfig: () => ({
        signingSecret: "signing-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      getRunningChat: () => ({ openDM }),
      hasConnection: () => true,
      listSlackConnections: async () => [
        createSlackConnection("conn-team", { teamId: "T123" }),
      ],
      restartConnection: mock(async () => undefined),
      updateConnection: mock(async () => createSlackConnection("unused")),
    });

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
      })
    );

    expect(response.status).toBe(200);
    expect(openDM).toHaveBeenCalledWith("U123");
    expect(post).toHaveBeenCalledWith(
      "Welcome to Lobu, Ada. Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands."
    );
  });
});
