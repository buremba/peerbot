import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SlackConnectionCoordinator } from "../connections/slack-connection-coordinator.js";
import type { PlatformConnection } from "../connections/types.js";

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

type Deps = ConstructorParameters<typeof SlackConnectionCoordinator>[0];

/** Installation-store stub; override per test. */
function makeInstallationStore(
  overrides: Partial<ReturnType<Deps["getInstallationStore"]>> = {}
): ReturnType<Deps["getInstallationStore"]> {
  return {
    upsertByTeam: mock(async (organizationId: string, teamId: string) => ({
      id: `slackinst-${teamId}`,
      organizationId,
      teamId,
      config: { platform: "slack", botToken: "secret://ref" },
      status: "active" as const,
      createdAt: 0,
      updatedAt: 0,
    })),
    getById: mock(async () => null),
    getByTeamId: mock(async () => null),
    list: mock(async () => []),
    markStopped: mock(async () => undefined),
    delete: mock(async () => undefined),
    ...overrides,
  };
}

/** Deps stub with sensible no-op defaults; override per test. */
function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    createStateAdapter: mock(async () => ({})),
    ensureConnectionRunning: mock(async () => true),
    forwardWebhook: mock(async () => new Response("ok")),
    getRunningChat: () => undefined,
    listSlackConnections: async () => [],
    getInstallationStore: () => makeInstallationStore(),
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

  test("ensureWorkspaceInstallation upserts only tenant data to the installation store", async () => {
    // The OAuth install is an org/workspace-installation resource, not an
    // agent connection — it goes to slack_installations keyed on (org, team),
    // never agent_connections. Only tenant data (bot token + teamName/botUserId)
    // is passed; app-level creds stay env-sourced (the store/secret layer owns
    // token persistence).
    const upsertByTeam = mock(
      async (organizationId: string, teamId: string) => ({
        id: "slackinst-xyz",
        organizationId,
        teamId,
        config: { platform: "slack", botToken: "secret://ref" },
        status: "active" as const,
        createdAt: 0,
        updatedAt: 0,
      })
    );
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({ getInstallationStore: () => makeInstallationStore({ upsertByTeam }) })
    );

    const result = await coordinator.ensureWorkspaceInstallation(
      "org-acme",
      "T123",
      { botToken: "xoxb-tenant-token", botUserId: "U123", teamName: "Acme" }
    );

    expect(result).toEqual({ installationId: "slackinst-xyz" });
    expect(upsertByTeam).toHaveBeenCalledWith("org-acme", "T123", {
      botToken: "xoxb-tenant-token",
      botUserId: "U123",
      teamName: "Acme",
    });
    // No app secrets in the payload — only tenant data.
    const payload = upsertByTeam.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.signingSecret).toBeUndefined();
    expect(payload.clientId).toBeUndefined();
    expect(payload.clientSecret).toBeUndefined();
  });

  test("handleAppWebhook routes a matched team to its OAuth installation", async () => {
    const body = JSON.stringify({ team_id: "T777", type: "event_callback" });
    const forwarded: string[] = [];
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        // No agent-owned (BYO) slack connection for this team...
        listSlackConnections: async () => [],
        // ...but an OAuth installation exists.
        getInstallationStore: () => makeInstallationStore({
          getByTeamId: mock(async () => ({
            id: "slackinst-T777",
            organizationId: "org-acme",
            teamId: "T777",
            config: { platform: "slack", botToken: "secret://ref" },
            status: "active" as const,
            createdAt: 0,
            updatedAt: 0,
          })),
        }),
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
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
    expect(forwarded).toEqual(["slackinst-T777"]);
  });

  test("a stopped BYO connection does not preempt an active OAuth installation", async () => {
    const body = JSON.stringify({ team_id: "T888", type: "event_callback" });
    const forwarded: string[] = [];
    const coordinator = new SlackConnectionCoordinator(
      makeDeps({
        // A stopped BYO connection exists for this team...
        listSlackConnections: async () => [
          { ...createSlackConnection("conn-stopped", { teamId: "T888" }), status: "stopped" },
        ],
        // ...and an active OAuth installation. Routing must reach the install,
        // not 503 on the stopped row.
        getInstallationStore: () =>
          makeInstallationStore({
            getByTeamId: mock(async () => ({
              id: "slackinst-T888",
              organizationId: "org-acme",
              teamId: "T888",
              config: { platform: "slack", botToken: "secret://ref" },
              status: "active" as const,
              createdAt: 0,
              updatedAt: 0,
            })),
          }),
        forwardWebhook: mock(async (connectionId: string) => {
          forwarded.push(connectionId);
          return new Response("ok");
        }),
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
    expect(forwarded).toEqual(["slackinst-T888"]);
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
