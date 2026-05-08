import { afterEach, describe, expect, mock, test } from "bun:test";
import { GatewayClient } from "../gateway/sse-client";

describe("GatewayClient heartbeat ACKs", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("accepts nested platform metadata on job events", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          botId: "lobu-api",
          userId: "watcher_218",
          agentId: "marketing",
          conversationId: "marketing_watcher_218_run_120947",
          platform: "api",
          channelId: "api_watcher_218",
          messageId: "message-1",
          messageText: "run watcher",
          platformMetadata: {
            agentId: "marketing",
            source: "watcher-run",
            intent: { kind: "watcher_run", runId: 120947, watcherId: 218 },
          },
          agentOptions: {},
        },
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].platformMetadata.intent
    ).toEqual({
      kind: "watcher_run",
      runId: 120947,
      watcherId: 218,
    });
  });

  test("ACKs heartbeat pings over the worker response endpoint", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, _options?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );

    await (client as any).handleEvent(
      "ping",
      JSON.stringify({ timestamp: Date.now() })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gateway.example.com/worker/response"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer worker-token",
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ received: true, heartbeat: true })
    );
  });
});
