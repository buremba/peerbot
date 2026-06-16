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
