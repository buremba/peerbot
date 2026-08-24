import { describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { InMemoryStateAdapter } from "../../../__tests__/fixtures/in-memory-state-adapter.js";
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
    displayName: "Emre",
    email: "emre@lobu.ai",
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

describe("Google Chat platform compatibility", () => {
  test("dispatches Google's standalone MESSAGE payload to the DM handler", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
    });

    const response = await chat.webhooks.gchat(webhook(standardDirectMessage()));
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["hello Lobu"]);
  });

  test("dispatches a standalone space mention to the mention handler", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
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
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["@lobu help"]);
  });

  test("dispatches standalone CARD_CLICKED action metadata", async () => {
    const chat = await createTestChat();
    const delivered: Array<{ actionId: string; value?: string }> = [];
    chat.onAction("approve", async (event) => {
      delivered.push({ actionId: event.actionId, value: event.value });
    });
    const messageEvent = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        type: "CARD_CLICKED",
        eventTime: messageEvent.eventTime,
        space: messageEvent.space,
        user: messageEvent.user,
        message: messageEvent.message,
        action: {
          actionMethodName: "approve",
          parameters: [{ key: "value", value: "invoice-42" }],
        },
      }),
    );
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(delivered).toEqual([{ actionId: "approve", value: "invoice-42" }]);
  });

  test("turns stored credential JSON into a least-privilege auth client", async () => {
    const adapter = (await gchatPlatform.createAdapter({
      credentials,
      disableSignatureVerification: true,
    })) as any;

    expect(adapter.authClient.email).toBe(
      "lobu-chat@example.iam.gserviceaccount.com",
    );
    expect(adapter.authClient.scopes).toEqual([
      "https://www.googleapis.com/auth/chat.bot",
    ]);
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
