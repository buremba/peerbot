/**
 * F12 end-to-end: an interaction card raised from a HEADLESS run is stamped
 * with its origin and DELIVERED on first claim, instead of owner-gating →
 * re-queueing 30x → dead-lettering (which hangs the worker).
 *
 * This drives the REAL chain with a REAL per-run worker token — exactly the
 * token the worker now sends (gwParams.workerToken = runJobToken):
 *
 *   POST /internal/interactions/create  (real authenticateWorker verifies the
 *     token and exposes its `source`)
 *     → InteractionService.postQuestion
 *     → ApiPlatform enqueues a thread_response stamped platformMetadata.source
 *     → UnifiedThreadResponseConsumer delivers it WITHOUT an SSE owner.
 *
 * The token's `source` comes from `generateWorkerToken({ source })` round-
 * tripped through real encryption + verifyWorkerToken, so this also proves the
 * new WorkerTokenData.source field survives the wire.
 */

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { generateWorkerToken } from "@lobu/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiPlatform } from "../../../gateway/api/platform";
import { InteractionService } from "../../../gateway/interactions";
import { UnifiedThreadResponseConsumer } from "../../../gateway/platform/unified-thread-consumer";
import { createInteractionRoutes } from "../../../gateway/routes/internal/interactions";
import { cleanupTestDatabase } from "../../setup/test-db";

describe("F12 headless interaction-card delivery (e2e)", () => {
  const prevKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    // The route's authenticateWorker checks a DB-backed revoked-token store.
    await cleanupTestDatabase();
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prevKey;
  });

  it("delivers a headless ask_user card on first claim (no SSE owner, no re-queue)", async () => {
    const conversationId = "agent_user_thread-1";

    // 1) Real InteractionService + ApiPlatform wired to a capturing queue.
    const interactionService = new InteractionService();
    const sends: Array<{ topic: string; payload: any }> = [];
    const apiServices = {
      getInteractionService: () => interactionService,
      getQueue: () => ({
        send: vi.fn(async (topic: string, payload: any) => {
          sends.push({ topic, payload });
        }),
      }),
      getSseManager: () => ({
        broadcast: vi.fn(),
        hasActiveConnection: vi.fn(() => false),
      }),
    };
    const apiPlatform = new ApiPlatform();
    await apiPlatform.initialize(apiServices as never);

    // 2) Mount the REAL interaction route and POST with a REAL per-run worker
    //    token whose `source` marks the run headless (a watcher run).
    const app = new Hono();
    app.route("/", createInteractionRoutes(interactionService));
    const runJobToken = generateWorkerToken("user", conversationId, "deploy-1", {
      channelId: conversationId,
      agentId: "agent",
      organizationId: "org",
      platform: "api",
      source: "watcher-run",
      runId: 1,
    });

    const res = await app.request("/internal/interactions/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runJobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        interactionType: "question",
        question: "Proceed with the watcher action?",
        options: ["yes", "no"],
      }),
    });
    expect(res.status).toBe(200);

    // 3) ApiPlatform enqueued the card stamped with the headless source.
    expect(sends).toHaveLength(1);
    const cardPayload = sends[0]!.payload;
    expect(sends[0]!.topic).toBe("thread_response");
    expect(cardPayload.platformMetadata).toEqual({ source: "watcher-run" });
    expect(cardPayload.customEvent?.requireSseOwner).toBe(true);

    // 4) The owner-gate consumer (no SSE connection anywhere) DELIVERS it on
    //    first claim instead of throwing to re-queue.
    const broadcast = vi.fn();
    const consumer = new UnifiedThreadResponseConsumer(
      {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        createQueue: vi.fn(async () => undefined),
        work: vi.fn(async () => undefined),
      } as never,
      {
        get: vi.fn(() => ({
          getResponseRenderer: () => ({
            handleCompletion: vi.fn(async () => undefined),
            handleError: vi.fn(async () => undefined),
          }),
        })),
      } as never,
      { broadcast, hasActiveConnection: vi.fn(() => false) } as never
    ) as any;

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: cardPayload })
    ).resolves.toBeUndefined();

    const questionBroadcasts = broadcast.mock.calls.filter(
      (call: any[]) => call[1] === "question"
    );
    expect(questionBroadcasts.length).toBe(1);
    expect(questionBroadcasts[0][0]).toBe(conversationId);
  });

  it("still owner-gates a card from an INTERACTIVE run (no source) so it routes to the browser's pod", async () => {
    const conversationId = "agent_user_thread-2";
    const interactionService = new InteractionService();
    const sends: Array<{ topic: string; payload: any }> = [];
    const apiPlatform = new ApiPlatform();
    await apiPlatform.initialize({
      getInteractionService: () => interactionService,
      getQueue: () => ({
        send: vi.fn(async (topic: string, payload: any) => {
          sends.push({ topic, payload });
        }),
      }),
      getSseManager: () => ({
        broadcast: vi.fn(),
        hasActiveConnection: vi.fn(() => false),
      }),
    } as never);

    const app = new Hono();
    app.route("/", createInteractionRoutes(interactionService));
    // Interactive run: token carries NO source.
    const token = generateWorkerToken("user", conversationId, "deploy-1", {
      channelId: conversationId,
      agentId: "agent",
      organizationId: "org",
      platform: "api",
      runId: 2,
    });
    await app.request("/internal/interactions/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        interactionType: "question",
        question: "Proceed?",
        options: ["yes"],
      }),
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.platformMetadata).toBeUndefined();

    // No SSE owner on this pod → must re-queue for the owning pod, NOT deliver.
    const broadcast = vi.fn();
    const consumer = new UnifiedThreadResponseConsumer(
      {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        createQueue: vi.fn(async () => undefined),
        work: vi.fn(async () => undefined),
      } as never,
      {
        get: vi.fn(() => ({
          getResponseRenderer: () => ({
            handleCompletion: vi.fn(async () => undefined),
            handleError: vi.fn(async () => undefined),
          }),
        })),
      } as never,
      { broadcast, hasActiveConnection: vi.fn(() => false) } as never
    ) as any;

    await expect(
      consumer.handleThreadResponse({ id: "job-2", data: sends[0]!.payload })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
