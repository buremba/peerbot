/**
 * Integration test for SseFanout against a real Postgres LISTEN/NOTIFY.
 *
 * Reproduces the multi-replica gap: SSE events are broadcast on whichever pod
 * claimed the work (thread_response row / worker spawn), but the client's SSE
 * connection is pinned by ClientIP affinity to a possibly-different pod. With a
 * pod-local in-memory SseManager the event is silently dropped.
 *
 * Two SseManager+SseFanout pairs in one process (each with its own `origin`)
 * faithfully model two pods sharing one database: the fan-out NOTIFY is the
 * exact production transport (`pg_notify` over the shared listener socket), so
 * cross-pod delivery here proves the production guarantee.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SseFanout } from "../services/sse-fanout.js";
import { type SseConnection, SseManager } from "../services/sse-manager.js";
import { ensureDbForGatewayTests } from "./helpers/db-setup.js";

function fakeStream(): SseConnection & {
  events: Array<{ event: string; data: string }>;
} {
  const events: Array<{ event: string; data: string }> = [];
  return {
    events,
    writeSSE(payload) {
      events.push(payload);
    },
  } as SseConnection & { events: Array<{ event: string; data: string }> };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

let podA: SseManager;
let podB: SseManager;
let fanoutA: SseFanout;
let fanoutB: SseFanout;

beforeAll(async () => {
  await ensureDbForGatewayTests();
  podA = new SseManager();
  podB = new SseManager();
  fanoutA = new SseFanout(podA);
  fanoutB = new SseFanout(podB);
  await fanoutA.start();
  await fanoutB.start();
});

afterAll(async () => {
  await fanoutA?.stop();
  await fanoutB?.stop();
});

describe("SseFanout cross-replica delivery", () => {
  test("a broadcast on pod A reaches a connection held on pod B", async () => {
    const stream = fakeStream();
    podB.addConnection("agent-cross", stream);

    podA.broadcast("agent-cross", "output", { content: "hello from A" });

    await waitFor(() => stream.events.length > 0);
    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]?.event).toBe("output");
    expect(stream.events[0]?.data).toBe(
      JSON.stringify({ content: "hello from A" })
    );
  });

  test("the originating pod does not double-deliver its own event", async () => {
    const onA = fakeStream();
    const onB = fakeStream();
    podA.addConnection("agent-dup", onA);
    podB.addConnection("agent-dup", onB);

    podA.broadcast("agent-dup", "output", { n: 1 });

    // B receives via fan-out; A delivered locally exactly once and must NOT
    // also re-deliver its own NOTIFY (origin-skip).
    await waitFor(() => onB.events.length > 0);
    await new Promise((r) => setTimeout(r, 100)); // allow any stray loopback
    expect(onA.events).toHaveLength(1);
    expect(onB.events).toHaveLength(1);
  });

  test("peer events seed the backlog everywhere; a late connection on any pod replays them", async () => {
    // No connection for this agent on either pod at broadcast time — the
    // POST→SSE-connect gap, or an affinity failover to a pod that never saw
    // the event live. Every pod must retain replay state.
    podA.broadcast("agent-late", "complete", { processedMessageIds: ["m1"] });

    await waitFor(() => podB.getRecentEvents("agent-late").length > 0);
    const seeded = podB.getRecentEvents("agent-late");
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.event).toBe("complete");

    // A connection attaching to pod B later replays it (mirrors the
    // GET /events backlog replay in routes/public/agent.ts).
    const stream = fakeStream();
    podB.addConnection("agent-late", stream);
    for (const entry of podB.getRecentEvents("agent-late")) {
      stream.writeSSE?.({
        event: entry.event,
        data: JSON.stringify(entry.data),
      });
    }
    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]?.data).toBe(
      JSON.stringify({ processedMessageIds: ["m1"] })
    );
  });

  test("publish order is preserved across the pool (serialized chain)", async () => {
    const stream = fakeStream();
    podB.addConnection("agent-order", stream);

    for (let i = 0; i < 25; i++) {
      podA.broadcast("agent-order", "output", { seq: i });
    }

    await waitFor(() => stream.events.length === 25, 5000);
    const seqs = stream.events.map(
      (e) => (JSON.parse(e.data) as { seq: number }).seq
    );
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("oversized events stay local-only without poisoning the chain", async () => {
    const onB = fakeStream();
    podB.addConnection("agent-big", onB);

    podA.broadcast("agent-big", "tool_use", { blob: "x".repeat(8000) });
    podA.broadcast("agent-big", "output", { after: true });

    // The oversized event must not cross pods; the next (small) one must.
    await waitFor(() => onB.events.length > 0);
    expect(onB.events).toHaveLength(1);
    expect(onB.events[0]?.event).toBe("output");
    // Local backlog on the origin pod still has both.
    expect(
      podA.getRecentEvents("agent-big").map((entry) => entry.event)
    ).toEqual(["tool_use", "output"]);
  });

  test("closeAgent on pod A purges pod B's connections and backlog", async () => {
    const onB = fakeStream();
    podB.addConnection("agent-close", onB);
    podA.broadcast("agent-close", "question", { questionId: "q1" });
    await waitFor(() => onB.events.length === 1);
    expect(podB.getRecentEvents("agent-close")).toHaveLength(1);

    podA.closeAgent("agent-close", "session deleted");

    await waitFor(
      () => podB.getRecentEvents("agent-close").length === 0,
      3000
    );
    // Peer connection received the closed event and was dropped.
    expect(
      onB.events.some((event) => event.event === "closed")
    ).toBe(true);
    expect(podB.hasActiveConnection("agent-close")).toBe(false);
  });
});
