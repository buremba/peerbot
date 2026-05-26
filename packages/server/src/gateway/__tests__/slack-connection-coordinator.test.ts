import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SlackConnectionCoordinator } from "../connections/slack-connection-coordinator.js";
import type {
  PlatformAdapterConfig,
  PlatformConnection,
} from "../connections/types.js";

function createSlackConnection(
  id: string,
  metadata: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
  settings: PlatformConnection["settings"] = { allowGroups: true }
): PlatformConnection {
  return {
    id,
    platform: "slack",
    agentId: "template",
    config: {
      platform: "slack",
      signingSecret: "signing-secret",
      clientId: "client-id",
      clientSecret: "client-secret",
      ...config,
    } as any,
    settings,
    metadata,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Deps stub with sensible no-op defaults; override per test. */
function makeDeps(
  overrides: Partial<
    ConstructorParameters<typeof SlackConnectionCoordinator>[0]
  > = {}
): ConstructorParameters<typeof SlackConnectionCoordinator>[0] {
  return {
    addConnection: mock(async () => createSlackConnection("unused")),
    createStateAdapter: mock(async () => ({})),
    ensureConnectionRunning: mock(async () => true),
    forwardWebhook: mock(async () => new Response("ok")),
    getRunningChat: () => undefined,
    hasConnection: () => true,
    listSlackConnections: async () => [],
    restartConnection: mock(async () => undefined),
    updateConnection: mock(async () => createSlackConnection("unused")),
    ...overrides,
  };
}

const SLACK_ENV_KEYS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_ENCRYPTION_KEY",
  "SLACK_INSTALLATION_KEY_PREFIX",
  "SLACK_USER_NAME",
] as const;

describe("SlackConnectionCoordinator", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SLACK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SLACK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("ensureWorkspaceConnection is idempotent per team", async () => {
    const connections: PlatformConnection[] = [];
    const addConnection = mock(
      async (
        _platform: string,
        agentId: string | undefined,
        config: any,
        settings?: { allowGroups?: boolean },
        metadata?: Record<string, unknown>
      ) => {
        const connection = createSlackConnection("conn-1", metadata, config);
        connection.agentId = agentId;
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

    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        addConnection,
        hasConnection: () => false,
        listSlackConnections: async () => connections,
        restartConnection,
        updateConnection,
      })
    );

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

  test("ensureWorkspaceConnection persists only tenant data, not app secrets", async () => {
    // The Slack adapter reads signingSecret/clientId/clientSecret from env at
    // runtime, so a per-workspace connection must NOT bake them into its stored
    // config (that would duplicate the secret per tenant and block rotation).
    let storedConfig: PlatformAdapterConfig | undefined;
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        addConnection: mock(async (_platform, _agentId, config) => {
          storedConfig = config;
          return createSlackConnection("conn-new", {}, {});
        }),
        hasConnection: () => false,
        listSlackConnections: async () => [],
      })
    );

    await coordinator.ensureWorkspaceConnection("T999", {
      botToken: "xoxb-tenant-token",
      botUserId: "U999",
      teamName: "Tenant",
    });

    const cfg = storedConfig as any;
    expect(cfg.platform).toBe("slack");
    expect(cfg.botToken).toBe("xoxb-tenant-token");
    expect(cfg.botUserId).toBe("U999");
    expect(cfg.signingSecret).toBeUndefined();
    expect(cfg.clientId).toBeUndefined();
    expect(cfg.clientSecret).toBeUndefined();
  });

  test("resolveAdapterConfig sources app creds from env (requireOAuth)", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-signing";
    process.env.SLACK_CLIENT_ID = "env-client-id";
    process.env.SLACK_CLIENT_SECRET = "env-client-secret";

    const coordinator = new SlackConnectionCoordinator(makeDeps());
    const config = coordinator.resolveAdapterConfig({ requireOAuth: true });

    expect(config).toMatchObject({
      platform: "slack",
      signingSecret: "env-signing",
      clientId: "env-client-id",
      clientSecret: "env-client-secret",
    });
  });

  test("resolveAdapterConfig throws when Slack env is absent", () => {
    const coordinator = new SlackConnectionCoordinator(makeDeps());
    expect(() => coordinator.resolveAdapterConfig()).toThrow(
      /SLACK_SIGNING_SECRET/
    );
    expect(() => coordinator.resolveAdapterConfig({ requireOAuth: true })).toThrow(
      /SLACK_SIGNING_SECRET/
    );
  });

  test("handleAppWebhook prefers an exact team match", async () => {
    const body = JSON.stringify({ team_id: "T123", type: "event_callback" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string, request: Request) => {
          return new Response(`${connectionId}:${await request.text()}`);
        }),
        listSlackConnections: async () => [
          createSlackConnection("conn-team", { teamId: "T123" }),
          createSlackConnection("conn-default"),
        ],
      })
    );

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

  test("handleAppWebhook routes a matched team without any Slack env (BYO)", async () => {
    // Sanity: env-sourcing in resolveAdapterConfig must not affect routing of a
    // webhook that resolves to a concrete connection — that path uses the
    // connection's own adapter, never resolveAdapterConfig. Env is unset here
    // (beforeEach cleared it) and routing must still succeed.
    const body = JSON.stringify({ team_id: "T777", type: "event_callback" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string) => {
          return new Response(connectionId);
        }),
        listSlackConnections: async () => [
          createSlackConnection("conn-byo", { teamId: "T777" }),
        ],
      })
    );

    const response = await coordinator.handleAppWebhook(
      new Request("https://gateway.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("conn-byo");
  });

  test("handleAppWebhook falls back to the shared preview Slack connection", async () => {
    const body = JSON.stringify({ type: "url_verification" });
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        forwardWebhook: mock(async (connectionId: string, request: Request) => {
          return new Response(`${connectionId}:${await request.text()}`);
        }),
        // The shared/hosted connection is the only safe no-team-match default:
        // it is explicitly previewMode and carries no teamId.
        listSlackConnections: async () => [
          createSlackConnection(
            "conn-default",
            {},
            {},
            { allowGroups: true, previewMode: true }
          ),
        ],
      })
    );

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

  test("getDefaultConnection refuses a non-preview tenant connection without a team match", async () => {
    // A plain tenant connection (no previewMode, no teamId) must never be the
    // no-team-match default — forwarding an unmatched-team webhook to it would
    // cross tenants (its own bot token). The fallback must fail closed.
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [
          createSlackConnection("conn-tenant"),
        ],
      })
    );

    expect(await coordinator.getDefaultConnection()).toBeNull();
  });

  test("getDefaultConnection returns the previewMode connection", async () => {
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        listSlackConnections: async () => [
          createSlackConnection("conn-tenant", { teamId: "T1" }),
          createSlackConnection(
            "conn-preview",
            {},
            {},
            { allowGroups: true, previewMode: true }
          ),
        ],
      })
    );

    const def = await coordinator.getDefaultConnection();
    expect(def?.id).toBe("conn-preview");
  });

  test("handleAppWebhook sends a welcome DM for team_join events", async () => {
    const post = mock(async () => undefined);
    const openDM = mock(async () => ({ post }));
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        getRunningChat: () => ({ openDM }),
        listSlackConnections: async () => [
          createSlackConnection("conn-team", { teamId: "T123" }),
        ],
      })
    );

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
