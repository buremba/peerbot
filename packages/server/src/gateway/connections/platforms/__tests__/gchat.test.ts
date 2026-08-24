import { describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { InMemoryStateAdapter } from "../../../__tests__/fixtures/in-memory-state-adapter.js";
import { ChatInstanceManager } from "../../chat-instance-manager.js";
import { parseConfig } from "../../chat-connection-service.js";
import { gchatPlatform } from "../gchat.js";

const credentials = JSON.stringify({
  client_email: "lobu-chat@example.iam.gserviceaccount.com",
  private_key: "not-used-by-the-inbound-webhook-test",
  project_id: "lobu-chat-test",
});

function standardDirectMessage(text = "hello Lobu"): any {
  const space = {
    name: "spaces/AAAA-test",
    type: "DM",
    spaceType: "DIRECT_MESSAGE",
  };
  const user = {
    name: "users/123",
    displayName: "Test User",
    email: "test.user@example.com",
    type: "HUMAN",
  };
  return {
    type: "MESSAGE",
    eventTime: "2026-08-24T12:00:00Z",
    space,
    user,
    message: {
      name: "spaces/AAAA-test/messages/message-1",
      createTime: "2026-08-24T12:00:00Z",
      text,
      sender: user,
      space,
    },
  };
}

async function createTestChat() {
  const adapter = await gchatPlatform.createAdapter({
    credentials,
    disableSignatureVerification: true,
    userName: "lobu",
  });
  const chat = new Chat({
    userName: "lobu",
    adapters: { gchat: adapter },
    state: new InMemoryStateAdapter(),
  });
  return chat;
}

function webhook(body: Record<string, unknown>) {
  return new Request("https://gateway.test/api/v1/webhooks/gchat-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForDelivery(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    Bun.sleep(1_000).then(() => {
      throw new Error("Timed out waiting for Google Chat event delivery");
    }),
  ]);
}

describe("Google Chat platform compatibility", () => {
  test("accepts only this project's Workspace Add-on token at the canonical connection webhook", async () => {
    const endpointUrl =
      "https://gateway.test/api/v1/webhooks/gchat-addon-test";
    const manager = new ChatInstanceManager() as any;
    manager.publicGatewayUrl = "https://gateway.test";
    const adapter = (await manager.createAdapter({
      id: "gchat-addon-test",
      platform: "gchat",
      config: {
        platform: "gchat",
        credentials,
        googleChatProjectNumber: "123456789",
        endpointUrl: "https://stale.example.test/wrong-connection",
      },
    })) as any;
    let verifiedAudience: string | string[] | undefined;
    let tokenEmail =
      "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
    adapter.oauth2Client.verifyIdToken = async ({ audience }: any) => {
      verifiedAudience = audience;
      return {
        getPayload: () => ({
          iss: "https://accounts.google.com",
          aud: endpointUrl,
          email_verified: true,
          email: tokenEmail,
        }),
      };
    };
    adapter.verifyProjectNumberToken = async () => false;

    const chat = new Chat({
      userName: "lobu",
      adapters: { gchat: adapter },
      state: new InMemoryStateAdapter(),
    });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });

    const response = await chat.webhooks.gchat(
      new Request(endpointUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer signed-by-google",
          "content-type": "application/json",
        },
        body: JSON.stringify(standardDirectMessage()),
      })
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(verifiedAudience).toBe(endpointUrl);
    expect(delivered).toEqual(["hello Lobu"]);

    tokenEmail =
      "service-987654321@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
    const wrongProjectResponse = await chat.webhooks.gchat(
      new Request(endpointUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer signed-by-another-google-project",
          "content-type": "application/json",
        },
        body: JSON.stringify(standardDirectMessage("wrong project")),
      })
    );
    expect(wrongProjectResponse.status).toBe(401);
    expect(delivered).toEqual(["hello Lobu"]);
  });

  test("dispatches Google's standalone MESSAGE payload to the DM handler", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });

    const response = await chat.webhooks.gchat(webhook(standardDirectMessage()));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["hello Lobu"]);
  });

  test("dispatches a standalone space mention to the mention handler", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("@Lobu help");
    event.space.type = "ROOM";
    event.space.spaceType = "SPACE";
    event.message.annotations = [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: 5,
        userMention: {
          user: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
          type: "MENTION",
        },
      },
    ];
    event.message.thread = { name: "spaces/AAAA-test/threads/thread-1" };

    const response = await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["@lobu help"]);
  });

  test("dispatches standalone CARD_CLICKED action metadata", async () => {
    const chat = await createTestChat();
    const delivered: Array<{ actionId: string; value?: string }> = [];
    const completion = Promise.withResolvers<void>();
    chat.onAction("approve", async (event) => {
      delivered.push({ actionId: event.actionId, value: event.value });
      completion.resolve();
    });
    const messageEvent = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        type: "CARD_CLICKED",
        eventTime: messageEvent.eventTime,
        space: messageEvent.space,
        user: messageEvent.user,
        message: messageEvent.message,
        common: { parameters: {} },
        action: {
          actionMethodName: "approve",
          parameters: [{ key: "value", value: "invoice-42" }],
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual([{ actionId: "approve", value: "invoice-42" }]);
  });

  test("retains credential mode for impersonation and Workspace Events", async () => {
    const adapter = (await gchatPlatform.createAdapter({
      credentials,
      disableSignatureVerification: true,
      impersonateUser: "admin@example.com",
    })) as any;

    expect(adapter.credentials).toEqual(JSON.parse(credentials));
    expect(adapter.authClient.email).toBe(
      "lobu-chat@example.iam.gserviceaccount.com",
    );
    expect(adapter.authClient.scopes).toContain(
      "https://www.googleapis.com/auth/chat.bot",
    );
    expect(adapter.impersonatedChatApi).toBeDefined();
    expect(adapter.getAuthOptions()).toEqual({
      credentials: JSON.parse(credentials),
      impersonateUser: "admin@example.com",
    });
  });

  test("retains ADC mode for impersonation and Workspace Events", async () => {
    const adapter = (await gchatPlatform.createAdapter({
      useApplicationDefaultCredentials: true,
      disableSignatureVerification: true,
      impersonateUser: "admin@example.com",
    })) as any;

    expect(adapter.useADC).toBe(true);
    expect(adapter.impersonatedChatApi).toBeDefined();
    expect(adapter.getAuthOptions()).toEqual({
      useApplicationDefaultCredentials: true,
      impersonateUser: "admin@example.com",
    });
  });

  test("rejects malformed service-account JSON during connection validation", () => {
    expect(() =>
      parseConfig("gchat", {
        credentials: "not-json",
        googleChatProjectNumber: "123456789",
      })
    ).toThrow(/service account JSON is invalid/);
  });

  test("rejects malformed service-account JSON before adapter startup", async () => {
    await expect(
      gchatPlatform.createAdapter({
        credentials: "not-json",
        disableSignatureVerification: true,
      }),
    ).rejects.toThrow(/service account JSON is invalid/);
  });

  test("accepts ADC as the existing alternative to a JSON key", () => {
    expect(
      parseConfig("gchat", {
        useApplicationDefaultCredentials: true,
        googleChatProjectNumber: "123456789",
      }),
    ).toEqual({
      platform: "gchat",
      useApplicationDefaultCredentials: true,
      googleChatProjectNumber: "123456789",
    });
  });
});
