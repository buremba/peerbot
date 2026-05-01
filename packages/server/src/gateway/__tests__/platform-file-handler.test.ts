import { afterEach, describe, expect, mock, test } from "bun:test";
import { Readable } from "node:stream";
import { ChatInstanceManager } from "../connections/chat-instance-manager.js";

const originalFetch = globalThis.fetch;

describe("ChatInstanceManager platform file handlers", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("provides a telegram file handler that uploads via the active connection", async () => {
    const manager = new ChatInstanceManager() as any;
    manager.instances = new Map([
      [
        "conn-1",
        {
          connection: {
            id: "conn-1",
            platform: "telegram",
            config: { botToken: "telegram-token" },
            metadata: { botUsername: "owlettobot" },
          },
          chat: {},
        },
      ],
    ]);

    const adapter = manager
      .createPlatformAdapters()
      .find((platform) => platform.name === "telegram");
    const handler = adapter?.getFileHandler?.({
      connectionId: "conn-1",
      channelId: "6570514069",
      conversationId: "6570514069",
    });

    expect(handler).toBeDefined();

    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(init?.method).toBe("POST");
        expect(url).toBe(
          "https://api.telegram.org/bottelegram-token/sendDocument"
        );
        return Response.json({
          ok: true,
          result: {
            message_id: 321,
            document: { file_id: "file-123" },
          },
        });
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await handler!.uploadFile(
      Readable.from(Buffer.from("hello")),
      {
        filename: "test.txt",
        channelId: "6570514069",
        threadTs: "6570514069",
      }
    );

    expect(result).toEqual({
      fileId: "file-123",
      permalink: "https://t.me/owlettobot",
      name: "test.txt",
      size: 5,
    });
  });

  // Inbound file fetching is no longer the file handler's job — every
  // attachment is fetched via `Attachment.fetchData()` and republished as a
  // gateway artifact in `MessageHandlerBridge.ingestAttachments`. The
  // worker downloads from the artifact URL, so platform handlers only need
  // to implement outbound `uploadFile`.
});
