/**
 * Pins the device REGISTRATION wire shape: the fields `worker-api/poll.ts`
 * reads are present, correctly typed, and unnormalized.
 *
 * Omitting `platform` is fail-closed, not a bypass — the server authorizes
 * every user-scoped worker and `authorizeCapabilities(undefined, declared)`
 * drops everything, so the worker simply never claims. Sending the platform is
 * what makes it functional. The allowlist itself is covered by @lobu/core.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { WorkerClient } from "../daemon/client";

type Captured = { url: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch, capture the one poll request, return an empty poll response. */
function capturePoll(): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ next_poll_seconds: 5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("device worker poll body", () => {
  test("a configured platform is sent, alongside app_version", async () => {
    const { calls } = capturePoll();
    await new WorkerClient({
      apiUrl: "https://app.example.com",
      workerId: "w-1",
      capabilities: { "os.files": true },
      platform: "macos",
      version: "2.3.4",
    }).poll();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://app.example.com/api/workers/poll");
    expect(calls[0].body).toMatchObject({
      worker_id: "w-1",
      capabilities: { "os.files": true },
      platform: "macos",
      app_version: "2.3.4",
    });
  });

  test("a fleet worker (no platform) sends no platform key at all", async () => {
    // Sending platform:null/"" would bind the device_workers row to a bogus
    // platform; the field must be absent, not empty.
    const { calls } = capturePoll();
    await new WorkerClient({
      apiUrl: "https://app.example.com",
      workerId: "w-2",
      capabilities: { db_egress_hardening: true },
    }).poll();

    expect(calls[0].body).not.toHaveProperty("platform");
    expect(calls[0].body).not.toHaveProperty("app_version");
    expect(calls[0].body).toMatchObject({
      worker_id: "w-2",
      capabilities: { db_egress_hardening: true },
    });
  });

  test("a blank platform is treated as absent, never sent as an empty string", async () => {
    const { calls } = capturePoll();
    await new WorkerClient({
      apiUrl: "https://app.example.com",
      workerId: "w-3",
      capabilities: {},
      platform: "   ",
      label: "   ",
    }).poll();

    expect(calls[0].body).not.toHaveProperty("platform");
    expect(calls[0].body).not.toHaveProperty("label");
  });

  test("a label is forwarded for the Devices page", async () => {
    const { calls } = capturePoll();
    await new WorkerClient({
      apiUrl: "https://app.example.com",
      workerId: "w-4",
      capabilities: { "os.files": true },
      platform: "macos",
      label: "Buraks-MacBook-Pro",
    }).poll();

    expect(calls[0].body).toMatchObject({ label: "Buraks-MacBook-Pro" });
  });

  test("capability names survive verbatim — the server matches them as strings", async () => {
    // `required_capability` is compared with `= ANY(...)` against these exact
    // strings, so any normalization here (case-folding, dot handling) would
    // silently stop claim branch (1B) from ever matching.
    const { calls } = capturePoll();
    await new WorkerClient({
      apiUrl: "https://app.example.com",
      workerId: "w-5",
      capabilities: { "os.files": true, "os.shell": false },
      platform: "macos",
    }).poll();

    expect(calls[0].body.capabilities).toEqual({
      "os.files": true,
      "os.shell": false,
    });
  });
});
