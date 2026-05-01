/**
 * Tests for SseManager — backlog pruning, dead-connection sweep, and
 * broadcast semantics. Covers behavior previously inlined in
 * `routes/public/agent.ts` so we don't regress on extraction.
 */

import { describe, expect, test } from "bun:test";
import { SseManager, type SseConnection } from "../services/sse-manager.js";

function fakeStream(): SseConnection & {
  events: Array<{ event: string; data: string }>;
  failOnNextWrite: boolean;
} {
  const events: Array<{ event: string; data: string }> = [];
  return {
    events,
    failOnNextWrite: false,
    writeSSE(payload) {
      if ((this as any).failOnNextWrite) {
        (this as any).failOnNextWrite = false;
        throw new Error("boom");
      }
      events.push(payload);
    },
  } as any;
}

describe("SseManager", () => {
  test("broadcast delivers events to all live connections for the agent", () => {
    const mgr = new SseManager();
    const a = fakeStream();
    const b = fakeStream();
    mgr.addConnection("agent-1", a);
    mgr.addConnection("agent-1", b);

    mgr.broadcast("agent-1", "output", { hello: "world" });

    expect(a.events).toHaveLength(1);
    expect(a.events[0]?.event).toBe("output");
    expect(a.events[0]?.data).toBe(JSON.stringify({ hello: "world" }));
    expect(b.events).toHaveLength(1);
  });

  test("broadcast to an agent with no connections still records backlog", () => {
    const mgr = new SseManager();
    mgr.broadcast("agent-2", "output", { n: 1 });

    const stream = fakeStream();
    mgr.addConnection("agent-2", stream);

    const backlog = mgr.getRecentEvents("agent-2");
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.event).toBe("output");
  });

  test("backlog is capped at the configured limit (most-recent wins)", () => {
    const mgr = new SseManager(3);
    for (let i = 0; i < 10; i++) {
      mgr.broadcast("agent", "output", { n: i });
    }

    const backlog = mgr.getRecentEvents("agent");
    expect(backlog).toHaveLength(3);
    const values = backlog.map((e) => (e.data as { n: number }).n);
    expect(values).toEqual([7, 8, 9]);
  });

  test("dead connections are swept on broadcast write failure", () => {
    const mgr = new SseManager();
    const healthy = fakeStream();
    const dying = fakeStream();
    dying.failOnNextWrite = true;
    mgr.addConnection("agent", healthy);
    mgr.addConnection("agent", dying);

    mgr.broadcast("agent", "output", { n: 1 });

    expect(mgr.connectionCount("agent")).toBe(1);
    expect(mgr.hasActiveConnection("agent")).toBe(true);
    // Subsequent broadcast should only reach the healthy stream.
    mgr.broadcast("agent", "output", { n: 2 });
    expect(healthy.events).toHaveLength(2);
    expect(dying.events).toHaveLength(0);
  });

  test("connections reporting closed/destroyed/writableEnded are treated as dead", () => {
    const mgr = new SseManager();
    const closed = fakeStream();
    (closed as any).closed = true;
    mgr.addConnection("agent", closed);

    mgr.broadcast("agent", "output", { n: 1 });

    expect(closed.events).toHaveLength(0);
    expect(mgr.connectionCount("agent")).toBe(0);
    expect(mgr.hasActiveConnection("agent")).toBe(false);
  });

  test("removeConnection cleans up the per-agent set", () => {
    const mgr = new SseManager();
    const stream = fakeStream();
    mgr.addConnection("agent", stream);
    expect(mgr.hasActiveConnection("agent")).toBe(true);
    mgr.removeConnection("agent", stream);
    expect(mgr.hasActiveConnection("agent")).toBe(false);
    expect(mgr.connectionCount("agent")).toBe(0);
  });

  test("totalConnections sums across all agents", () => {
    const mgr = new SseManager();
    mgr.addConnection("a", fakeStream());
    mgr.addConnection("a", fakeStream());
    mgr.addConnection("b", fakeStream());
    expect(mgr.totalConnections()).toBe(3);
  });

  test("closeAgent writes a closed event, clears connections, and drops backlog", () => {
    const mgr = new SseManager();
    const stream = fakeStream();
    mgr.addConnection("agent", stream);
    mgr.broadcast("agent", "output", { n: 1 });

    mgr.closeAgent("agent", "agent_deleted");

    expect(stream.events.at(-1)?.event).toBe("closed");
    expect(stream.events.at(-1)?.data).toBe(
      JSON.stringify({ reason: "agent_deleted" })
    );
    expect(mgr.hasActiveConnection("agent")).toBe(false);
    expect(mgr.getRecentEvents("agent")).toEqual([]);
  });

  test("rememberEvent + getRecentEvents with since filter", () => {
    const mgr = new SseManager();
    const base = Date.now();
    mgr.rememberEvent("agent", { event: "a", data: 1, timestamp: base - 30 });
    mgr.rememberEvent("agent", { event: "b", data: 2, timestamp: base - 20 });
    mgr.rememberEvent("agent", { event: "c", data: 3, timestamp: base - 10 });

    const since = mgr.getRecentEvents("agent", base - 25);
    expect(since.map((e) => e.event)).toEqual(["b", "c"]);
  });

  test("expired backlog entries are pruned on read", () => {
    // 10ms TTL so we can advance past it with a real timestamp.
    const mgr = new SseManager(100, 10);
    mgr.rememberEvent("agent", {
      event: "stale",
      data: null,
      timestamp: Date.now() - 1000,
    });
    // A second read-after-TTL should return nothing.
    expect(mgr.getRecentEvents("agent")).toEqual([]);
  });
});
