/**
 * Webhook signature verification — regression tests.
 *
 * Inbound chat-platform webhooks are authenticated by the Chat SDK adapter,
 * not the HTTP route. These tests pin that contract:
 *
 *  1. The Slack adapter (`@chat-adapter/slack`) rejects a forged
 *     `x-slack-signature` with HTTP 401 and accepts a correctly-signed
 *     payload — proving the HMAC-SHA256(`v0:{ts}:{rawBody}`) check is live.
 *  2. The `/slack/events` route keeps its edge-layer freshness-window check
 *     (replay defense) and forwards everything else to
 *     `ChatInstanceManager.handleSlackAppWebhook`, which fans out to the
 *     adapter described above.
 */

import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { describe, expect, it, vi } from "vitest";
import { createSlackRoutes } from "../gateway/routes/public/slack.js";
import type { ChatInstanceManager } from "../gateway/connections/chat-instance-manager.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function slackSignature(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("Slack adapter webhook signature verification", () => {
  const adapter = createSlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: "xoxb-test",
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
  });

  it("rejects a payload with a forged signature (401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ts = nowTs();
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        // Wrong secret → signature won't match.
        "x-slack-signature": `v0=${createHmac("sha256", "not-the-secret")
          .update(`v0:${ts}:${body}`)
          .digest("hex")}`,
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("rejects a payload with no signature header (401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": nowTs(),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("rejects a stale-but-correctly-signed payload (replay, 401)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 60); // 1h old
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": slackSignature(body, ts),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-signed url_verification challenge", async () => {
    const challenge = "test-challenge-123";
    const body = JSON.stringify({ type: "url_verification", challenge });
    const ts = nowTs();
    const req = new Request("https://example.test/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": slackSignature(body, ts),
      },
      body,
    });

    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe(challenge);
  });
});

describe("/slack/events route", () => {
  function makeRouter(handleSlackAppWebhook: (req: Request) => Promise<Response>) {
    const manager = {
      handleSlackAppWebhook,
      getServices: () => ({ getPublicGatewayUrl: () => undefined }),
    } as unknown as ChatInstanceManager;
    return createSlackRoutes(manager);
  }

  it("rejects a stale timestamp at the edge before delegating", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const router = makeRouter(handler);
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);

    const res = await router.request("/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": staleTs },
      body: "{}",
    });

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("delegates a fresh request to ChatInstanceManager.handleSlackAppWebhook", async () => {
    const handler = vi.fn(async () => new Response("forwarded", { status: 200 }));
    const router = makeRouter(handler);

    const res = await router.request("/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": nowTs() },
      body: JSON.stringify({ type: "event_callback" }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("forwarded");
  });

  it("surfaces a 500 when delegation throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const router = makeRouter(handler);

    const res = await router.request("/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": nowTs() },
      body: "{}",
    });

    expect(res.status).toBe(500);
  });
});
