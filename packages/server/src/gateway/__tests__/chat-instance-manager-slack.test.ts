import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  ensurePgliteForGatewayTests,
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
  await ensurePgliteForGatewayTests();
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

  test("restartConnection persists error state when secret refs cannot be resolved", async () => {
    // When a connection's secret ref becomes unresolvable between restarts
    // (secret wiped, backend down, etc), restartConnection must:
    //   1) stamp the stored record with status=error + errorMessage
    //   2) re-throw so the caller knows the restart failed
    // It MUST NOT auto-delete the connection — that's initialize()'s
    // startup-only job. The operator needs to see the error and decide
    // how to fix.
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    try {
      await resetTestDatabase();
      // chat_connections.template_agent_id has an FK on agents(id).
      await seedAgentRow("agent-1");
      const ChatInstanceManager = await loadChatInstanceManager();
      const { SecretStoreRegistry } = await import("../secrets/index.js");
      const { ChatConnectionStore } = await import(
        "../connections/chat-connection-store.js"
      );

      // Empty in-memory secret store: any secret-ref lookup returns null,
      // forcing resolveConfigForRuntime to throw.
      const backingStore: any = {
        async get() {
          return null;
        },
        async put(_n: string, _v: string) {
          return "secret://noop";
        },
        async delete() {
          /* noop */
        },
        async list() {
          return [];
        },
      };
      const secretStore = new SecretStoreRegistry(backingStore, {
        secret: backingStore,
      });

      const services = {
        getQueue: () => ({}),
        getPublicGatewayUrl: () => "",
        getSecretStore: () => secretStore,
      } as any;

      const manager = new ChatInstanceManager() as any;
      manager.services = services;
      manager.publicGatewayUrl = "";

      // Seed a connection whose `botToken` is a secret ref that doesn't
      // exist in the store — resolveConfigForRuntime will throw.
      const connectionId = "conn-broken";
      const store = new ChatConnectionStore();
      await store.upsert({
        id: connectionId,
        platform: "telegram",
        templateAgentId: "agent-1",
        config: {
          platform: "telegram",
          botToken: "secret://connections%2Fconn-broken%2FbotToken",
        } as any,
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(manager.restartConnection(connectionId)).rejects.toThrow(
        /Failed to resolve secret ref/
      );

      // Connection record must still exist with status=error and a
      // descriptive errorMessage.
      const sanitized = await manager.getConnection(connectionId);
      expect(sanitized).not.toBeNull();
      expect(sanitized.status).toBe("error");
      expect(sanitized.errorMessage).toContain("Failed to resolve");
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
