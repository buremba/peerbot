/**
 * F12: the API platform must stamp the headless run origin onto interaction
 * cards so the owner-gate exempts them (a headless turn has no browser SSE on
 * any pod, so an owner-gated card would dead-letter and hang the worker).
 *
 * This drives the REAL InteractionService → ApiPlatform path and captures the
 * payload enqueued onto the thread_response queue.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiPlatform } from "../platform.js";
import { InteractionService } from "../../interactions.js";

function makePlatform() {
  const interactionService = new InteractionService();
  const sends: Array<{ topic: string; payload: any }> = [];
  const queue = {
    send: mock(async (topic: string, payload: any) => {
      sends.push({ topic, payload });
    }),
  };
  const sseManager = {
    broadcast: mock(() => undefined),
    hasActiveConnection: mock(() => false),
  };
  const services = {
    getInteractionService: () => interactionService,
    getQueue: () => queue,
    getSseManager: () => sseManager,
  };
  return { interactionService, sends, services };
}

describe("ApiPlatform interaction-card source stamping (F12)", () => {
  let platform: ApiPlatform;
  let ctx: ReturnType<typeof makePlatform>;

  beforeEach(async () => {
    platform = new ApiPlatform();
    ctx = makePlatform();
    await platform.initialize(ctx.services as never);
  });

  test("stamps platformMetadata.source on a card from a headless turn", async () => {
    await ctx.interactionService.postQuestion(
      "u1",
      "api:conv-1",
      "api:conv-1",
      undefined,
      undefined,
      "api",
      "Proceed?",
      ["yes", "no"],
      "watcher-run"
    );

    expect(ctx.sends).toHaveLength(1);
    const { topic, payload } = ctx.sends[0]!;
    expect(topic).toBe("thread_response");
    expect(payload.platformMetadata).toEqual({ source: "watcher-run" });
    expect(payload.customEvent?.requireSseOwner).toBe(true);
  });

  test("omits platformMetadata for an interactive (no-source) card", async () => {
    await ctx.interactionService.postQuestion(
      "u1",
      "api:conv-2",
      "api:conv-2",
      undefined,
      undefined,
      "api",
      "Proceed?",
      ["yes", "no"]
      // no source — interactive, browser-driven turn
    );

    expect(ctx.sends).toHaveLength(1);
    expect(ctx.sends[0]!.payload.platformMetadata).toBeUndefined();
    expect(ctx.sends[0]!.payload.customEvent?.requireSseOwner).toBe(true);
  });
});

// Gap A: API/SPA "Processing…" status messages were the one interaction the API
// platform did NOT fan out cross-pod, so under N>1 they were lost (posted on the
// worker's pod, the browser's SSE pinned to another). They must ride the same
// owner-gated thread_response queue as question/link-button/tool-approval, and
// surface as the SSE `status` event the SPA reads (`{ type: "status", status }`).
describe("ApiPlatform status-message cross-pod fan-out (Gap A)", () => {
  let platform: ApiPlatform;
  let ctx: ReturnType<typeof makePlatform>;

  beforeEach(async () => {
    platform = new ApiPlatform();
    ctx = makePlatform();
    await platform.initialize(ctx.services as never);
  });

  test("enqueues an interactive status message as the SSE `status` event", async () => {
    await ctx.interactionService.postStatusMessage(
      "api:conv-1",
      "api:conv-1",
      undefined,
      undefined,
      "api",
      "Processing…"
      // no source — interactive, browser-driven turn → owner-gated
    );

    expect(ctx.sends).toHaveLength(1);
    const { topic, payload } = ctx.sends[0]!;
    expect(topic).toBe("thread_response");
    // SSE event name the consumer broadcasts and the SPA listens for.
    expect(payload.customEvent?.name).toBe("status");
    // SPA reads payload.status (lobu-runtime-provider) — must match this shape.
    expect(payload.customEvent?.data).toEqual({
      type: "status",
      status: "Processing…",
    });
    // Owner-gated like the other API cards (browser SSE lives on one pod).
    expect(payload.customEvent?.requireSseOwner).toBe(true);
    // Interactive turn carries no source, so it stays owner-routed.
    expect(payload.platformMetadata).toBeUndefined();
    expect(payload.conversationId).toBe("api:conv-1");
  });

  test("propagates source so a headless status message bypasses the owner-gate", async () => {
    await ctx.interactionService.postStatusMessage(
      "api:conv-2",
      "api:conv-2",
      undefined,
      undefined,
      "api",
      "Refreshing connection…",
      "connector-repair"
    );

    expect(ctx.sends).toHaveLength(1);
    const { payload } = ctx.sends[0]!;
    // Headless source stamped → consumer's headless exemption applies (no SSE
    // owner exists on any pod for a connector-repair turn).
    expect(payload.platformMetadata).toEqual({ source: "connector-repair" });
    expect(payload.customEvent?.name).toBe("status");
    expect(payload.customEvent?.data).toEqual({
      type: "status",
      status: "Refreshing connection…",
    });
  });

  test("does NOT fan out a non-api status message (chat path owns those)", async () => {
    await ctx.interactionService.postStatusMessage(
      "slack:conv",
      "slack:conv",
      undefined,
      "conn-1",
      "slack",
      "Working…"
    );

    // ApiPlatform filters on platform === "api"; chat status fans out via
    // registerChatInteractionFanout, not here.
    expect(ctx.sends).toHaveLength(0);
  });
});
