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

  test("propagates runId and runJobToken from job payload to handleThreadMessage", async () => {
    // Regression test for the bug shipped in PR #871: snapshot mode became
    // the default, but JobEventSchema was a plain z.object() (default zod
    // mode strips unknown keys). MessageConsumer stamps runId + runJobToken
    // onto the MessagePayload before SSE dispatch, but those fields were
    // silently dropped by safeParse — so every snapshot-mode chat threw
    // "WorkerConfig.runId is missing" at boot. Pre-fix: this assertion
    // sees `undefined`. Post-fix: the fields survive parsing.
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
          botId: "lobu-bot",
          userId: "telegram-user-1",
          agentId: "default",
          conversationId: "telegram:6570514069",
          platform: "telegram",
          channelId: "6570514069",
          messageId: "6570514069:29",
          messageText: "hi",
          platformMetadata: {},
          agentOptions: {},
          runId: 12345,
          runJobToken: "per-run-jwt-abc",
        },
        jobId: "12345",
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    const forwarded = handleThreadMessage.mock.calls[0]?.[0];
    expect(forwarded.runId).toBe(12345);
    expect(forwarded.runJobToken).toBe("per-run-jwt-abc");
  });

  test("payloadToWorkerConfig threads runId + runJobToken into WorkerConfig", async () => {
    // The dispatch-path bug's second half: even if zod kept the fields,
    // payloadToWorkerConfig has to forward them onto the WorkerConfig the
    // worker reads at boot (worker.ts:353-360). Lock that mapping in.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const config = (client as any).payloadToWorkerConfig({
      botId: "lobu-bot",
      userId: "telegram-user-1",
      agentId: "default",
      conversationId: "telegram:6570514069",
      platform: "telegram",
      channelId: "6570514069",
      messageId: "6570514069:29",
      messageText: "hi",
      platformMetadata: {},
      agentOptions: {},
      runId: 67890,
      runJobToken: "per-run-jwt-xyz",
    });
    expect(config.runId).toBe(67890);
    expect(config.runJobToken).toBe("per-run-jwt-xyz");
  });

  test("payloadToWorkerConfig leaves runId/runJobToken undefined when absent (legacy direct-enqueue path)", async () => {
    // Backwards-compat: legacy direct-enqueue paths don't set runId. The
    // fields must survive end-to-end as `undefined`, not be coerced into
    // NaN/empty-string.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const config = (client as any).payloadToWorkerConfig({
      botId: "lobu-bot",
      userId: "user-1",
      agentId: "default",
      conversationId: "conv",
      platform: "api",
      channelId: "channel",
      messageId: "msg-1",
      messageText: "hi",
      platformMetadata: {},
      agentOptions: {},
    });
    expect(config.runId).toBeUndefined();
    expect(config.runJobToken).toBeUndefined();
  });

  test("batched messages merge attachment files from every message (no data loss)", async () => {
    // Regression test for F7: processBatchedMessages built the combined
    // payload by spreading firstMessage.payload and only concatenating
    // messageText, so files/images on the 2nd..Nth messages were dropped.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );

    // Capture the combined payload without booting a real worker.
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;

    const file1 = { id: "f1", name: "first.png" };
    const file2 = { id: "f2", name: "second.pdf" };

    await (client as any).processBatchedMessages([
      {
        timestamp: 1000,
        payload: {
          botId: "lobu-bot",
          userId: "user-1",
          agentId: "default",
          conversationId: "conv",
          platform: "telegram",
          channelId: "channel",
          messageId: "msg-1",
          messageText: "first",
          platformMetadata: { files: [file1] },
          agentOptions: {},
        },
      },
      {
        timestamp: 2000,
        payload: {
          botId: "lobu-bot",
          userId: "user-1",
          agentId: "default",
          conversationId: "conv",
          platform: "telegram",
          channelId: "channel",
          messageId: "msg-2",
          messageText: "second",
          // 2nd message carries the attachment that used to be dropped.
          platformMetadata: { files: [file2] },
          agentOptions: {},
        },
      },
    ]);

    expect(processSingleMessage).toHaveBeenCalledTimes(1);
    const combined = processSingleMessage.mock.calls[0]?.[0];

    // Both files survive, in message order.
    expect(combined.payload.platformMetadata.files).toEqual([file1, file2]);
    // Text concatenation ordering preserved.
    expect(combined.payload.messageText).toBe(
      "Message 1: first\n\nMessage 2: second"
    );
    // All message IDs forwarded for ACK.
    expect(processSingleMessage.mock.calls[0]?.[1]).toEqual(["msg-1", "msg-2"]);
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
