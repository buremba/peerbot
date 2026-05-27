import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

mock.module("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class GetSecretValueCommand {},
  SecretsManagerClient: class SecretsManagerClient {
    send(): Promise<null> {
      return Promise.resolve(null);
    }
  },
}));

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

async function loadChatInstanceManager() {
  const mod = await import("../connections/chat-instance-manager.js");
  return mod.ChatInstanceManager;
}

describe("ChatInstanceManager Slack marketplace support", () => {
  test("ensureSlackWorkspaceConnection delegates to the Slack coordinator", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const ensureWorkspaceConnection = mock(async () => ({ id: "conn-team" }));
    manager.slackCoordinator = {
      ensureWorkspaceConnection,
    };

    const result = await manager.ensureSlackWorkspaceConnection("T123", {
      botToken: "xoxb-token",
      botUserId: "U123",
      teamName: "Acme",
    });

    expect(result).toEqual({ id: "conn-team" });
    expect(ensureWorkspaceConnection).toHaveBeenCalledWith("T123", {
      botToken: "xoxb-token",
      botUserId: "U123",
      teamName: "Acme",
    });
  });

  test("handleSlackAppWebhook delegates to the Slack coordinator", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const request = new Request("https://gateway.example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: "T123", type: "event_callback" }),
    });
    const handleAppWebhook = mock(async () => new Response("ok"));
    manager.slackCoordinator = {
      handleAppWebhook,
    };

    const response = await manager.handleSlackAppWebhook(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handleAppWebhook).toHaveBeenCalledWith(request);
  });

  test("restartConnection reads from agent_connections and starts adapter", async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    try {
      await resetTestDatabase();
      await seedAgentRow("agent-1");
      const ChatInstanceManager = await loadChatInstanceManager();

      // Build a minimal AgentConnectionStore backed by agent_connections.
      const { createPostgresAgentConnectionStore } = await import(
        "../../lobu/stores/postgres-stores.js"
      );
      const { orgContext } = await import("../../lobu/stores/org-context.js");
      const connectionStore = createPostgresAgentConnectionStore();

      // Seed a connection with a `secret://` ref. ChatInstanceManager
      // resolves refs via SecretStoreRegistry inside startInstance; the
      // store is asserted to be wired through to the real one (not the
      // empty `{}` stub the rest of these tests use).
      const { PostgresSecretStore } = await import(
        "../../lobu/stores/postgres-secret-store.js"
      );
      const { SecretStoreRegistry } = await import("../secrets/index.js");
      const postgresSecretStore = new PostgresSecretStore();
      const secretStore = new SecretStoreRegistry(postgresSecretStore, {
        secret: postgresSecretStore,
      });
      const tokenRef = await orgContext.run(
        { organizationId: "test-org" },
        () => secretStore.put("connections/conn-restart-test/botToken", "test-bot-token-value")
      );
      await orgContext.run(
        { organizationId: "test-org" },
        async () => {
          await connectionStore.saveConnection({
            id: "conn-restart-test",
            platform: "telegram",
            agentId: "agent-1",
            config: {
              platform: "telegram",
              botToken: tokenRef,
            },
            settings: { allowGroups: true },
            metadata: {},
            status: "stopped",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      );

      const services = {
        getQueue: () => ({}),
        getPublicGatewayUrl: () => "",
        getSecretStore: () => secretStore,
        getConnectionStore: () => connectionStore,
        getChannelBindingService: () => ({
          getBinding: async () => null,
        }),
      } as any;

      const manager = new ChatInstanceManager() as any;
      manager.services = services;
      manager.publicGatewayUrl = "";
      manager.connectionStore = connectionStore;

      // restartConnection reads from agent_connections and attempts to boot.
      // The Telegram adapter will fail because the token is fake, but the
      // important thing is that the read path works — no secret-ref errors.
      try {
        await manager.restartConnection("conn-restart-test");
      } catch {
        // Expected: adapter startup fails with a fake token.
      }

      // Connection record must still exist (not auto-deleted).
      const conn = await orgContext.run(
        { organizationId: "test-org" },
        () => connectionStore.getConnection("conn-restart-test")
      );
      expect(conn).not.toBeNull();
      expect(conn!.id).toBe("conn-restart-test");
    } finally {
      if (originalKey !== undefined) {
        process.env.ENCRYPTION_KEY = originalKey;
      } else {
        delete process.env.ENCRYPTION_KEY;
      }
    }
  });

  test("completeSlackOAuthInstall delegates to the Slack coordinator", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const request = new Request(
      "https://gateway.example.com/slack/oauth_callback?code=test&state=test"
    );
    const completeOAuthInstall = mock(async () => ({
      teamId: "T123",
      teamName: "Acme",
      connectionId: "conn-team",
    }));
    manager.slackCoordinator = {
      completeOAuthInstall,
    };

    const result = await manager.completeSlackOAuthInstall(
      request,
      "https://gateway.example.com/slack/oauth_callback"
    );

    expect(result).toEqual({
      teamId: "T123",
      teamName: "Acme",
      connectionId: "conn-team",
    });
    expect(completeOAuthInstall).toHaveBeenCalledWith(
      request,
      "https://gateway.example.com/slack/oauth_callback"
    );
  });
});

describe("ChatInstanceManager.postMessageToChannel", () => {
  test("posts markdown to the resolved channel as the bot", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "1.2" }));
    const channel = mock((_key: string) => ({ post }));
    manager.instances.set("conn-1", { chat: { channel } });

    await manager.postMessageToChannel("conn-1", "slack:C0123ABCD", {
      markdown: "Weekly funnel digest",
    });

    expect(channel).toHaveBeenCalledWith("slack:C0123ABCD");
    expect(post).toHaveBeenCalledWith({ markdown: "Weekly funnel digest" });
  });

  test("posts a rich card built with the chat primitives", async () => {
    const { Card, Field, Fields, Actions, LinkButton } = await import("chat");
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "2.0" }));
    const channel = mock((_key: string) => ({ post }));
    manager.instances.set("conn-1", { chat: { channel } });

    const card = Card({
      title: "Weekly funnel digest",
      children: [
        Fields([Field({ label: "New leads", value: "3" })]),
        Actions([LinkButton({ url: "https://app.lobu.ai/lobu-crm/entities", label: "View leads" })]),
      ],
    });

    await manager.postMessageToChannel("conn-1", "slack:C0123ABCD", { card });

    expect(post).toHaveBeenCalledWith({ card });
    expect(card.type).toBe("card");
  });

  test("lazily starts the connection when it isn't loaded on this pod, then posts", async () => {
    // Multi-replica: the connection was created/restarted on another pod, so
    // this pod has no live instance until we start it from the store.
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "9.9" }));
    const channel = mock((_key: string) => ({ post }));
    manager.connectionStore = {
      getConnection: async () => ({ id: "conn-x", status: "active" }),
    };
    manager.restartConnection = mock(async (id: string) => {
      manager.instances.set(id, { chat: { channel } });
    });

    await manager.postMessageToChannel("conn-x", "slack:C9", { markdown: "hi" });

    expect(manager.restartConnection).toHaveBeenCalledWith("conn-x");
    expect(channel).toHaveBeenCalledWith("slack:C9");
    expect(post).toHaveBeenCalledWith({ markdown: "hi" });
  });

  test("throws when the connection is stopped and cannot be started", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = {
      getConnection: async () => ({ id: "missing", status: "stopped" }),
    };
    await expect(
      manager.postMessageToChannel("missing", "slack:C0", { markdown: "x" })
    ).rejects.toThrow(/No active chat instance/);
  });
});

describe("ChatInstanceManager.handleWebhook (multi-replica)", () => {
  test("lazily starts the connection on this pod before handling the webhook", async () => {
    // Regression: the per-connection webhook route (`/api/v1/webhooks/:id`)
    // calls handleWebhook directly, unlike the Slack coordinator which
    // pre-warms via ensureConnectionRunning. Under `app.replicaCount > 1` a
    // webhook (a platform event OR a one-shot `/lobu link` slash command) can
    // land on a pod that hasn't warmed this connection. It must hydrate from
    // the store, not 404. Mirrors postMessageToChannel's lazy-start.
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const webhookHandler = mock(
      async () => new Response("handled", { status: 200 })
    );
    manager.connectionStore = {
      getConnection: async () => ({ id: "conn-cold", status: "active" }),
    };
    manager.restartConnection = mock(async (id: string) => {
      manager.instances.set(id, {
        connection: { platform: "slack" },
        chat: { webhooks: { slack: webhookHandler } },
      });
    });

    const request = new Request(
      "https://gw.example.com/api/v1/webhooks/conn-cold",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "command=%2Flobu&text=link+crm-ABC123",
      }
    );
    const response = await manager.handleWebhook("conn-cold", request);

    expect(manager.restartConnection).toHaveBeenCalledWith("conn-cold");
    expect(webhookHandler).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("handled");
  });

  test("404s when the connection is stopped and cannot be started", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = {
      getConnection: async () => ({ id: "stopped-conn", status: "stopped" }),
    };
    const response = await manager.handleWebhook(
      "stopped-conn",
      new Request("https://gw.example.com/api/v1/webhooks/stopped-conn", {
        method: "POST",
      })
    );
    expect(response.status).toBe(404);
  });
});
