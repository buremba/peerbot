/**
 * Terminal-repair (Gap C): streaming `output` deltas are best-effort under N>1
 * replicas — a delta claimed on a pod that doesn't hold the client's SSE socket
 * is lost, leaving the SPA's accumulated text truncated. The worker stamps the
 * full authoritative reply onto the terminal row as `finalText`
 * (gateway-integration.signalCompletion); the API renderer MUST forward it on
 * the `complete` SSE event so the SPA can repair. Without it a cross-pod delta
 * loss is permanent with no repair path.
 */

import { describe, expect, mock, test } from "bun:test";
import { ApiResponseRenderer } from "../response-renderer.js";
import type { ThreadResponsePayload } from "../../infrastructure/queue/types.js";

function makeRenderer() {
  const broadcasts: Array<{ key: string; event: string; data: any }> = [];
  const sseManager = {
    broadcast: mock((key: string, event: string, data: any) => {
      broadcasts.push({ key, event, data });
    }),
  };
  const renderer = new ApiResponseRenderer(sseManager as never);
  return { renderer, broadcasts };
}

const basePayload = (over: Partial<ThreadResponsePayload>): ThreadResponsePayload =>
  ({
    messageId: "m1",
    conversationId: "api:conv-1",
    channelId: "api:conv-1",
    userId: "api",
    teamId: "api",
    timestamp: 100,
    processedMessageIds: ["m1"],
    ...over,
  }) as ThreadResponsePayload;

describe("ApiResponseRenderer.handleCompletion finalText repair", () => {
  test("forwards finalText on the complete SSE event", async () => {
    const { renderer, broadcasts } = makeRenderer();

    await renderer.handleCompletion(
      basePayload({ finalText: "the full assistant reply" }),
      "session-key"
    );

    const complete = broadcasts.find((b) => b.event === "complete");
    expect(complete).toBeDefined();
    expect(complete?.key).toBe("api:conv-1");
    expect(complete?.data).toMatchObject({
      type: "complete",
      messageId: "m1",
      finalText: "the full assistant reply",
    });
  });

  test("leaves finalText undefined when the worker streamed nothing extra", async () => {
    const { renderer, broadcasts } = makeRenderer();

    await renderer.handleCompletion(basePayload({}), "session-key");

    const complete = broadcasts.find((b) => b.event === "complete");
    expect(complete?.data.finalText).toBeUndefined();
  });
});

describe("ApiResponseRenderer.handleError targeting context", () => {
  test("forwards provider/model context on both browser error events", async () => {
    const { renderer, broadcasts } = makeRenderer();

    await renderer.handleError(
      basePayload({
        error: "quota exhausted",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        errorContext: { provider: "z-ai", model: "glm-5.2" },
      }),
      "session-key"
    );

    for (const event of ["error", "agent-error"]) {
      expect(broadcasts.find((b) => b.event === event)?.data).toMatchObject({
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        errorContext: { provider: "z-ai", model: "glm-5.2" },
      });
    }
  });
});
