/**
 * Tests for WorkerConnectionManager
 * Tests SSE connection lifecycle, heartbeats, and cleanup
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkerConnectionManager } from "../gateway/connection-manager.js";
import {
  cleanupTestEnv,
  MockResponse,
  setupTestEnv,
  TestHelpers,
} from "./setup.js";

describe("WorkerConnectionManager", () => {
  let manager: WorkerConnectionManager;

  beforeEach(() => {
    setupTestEnv();
    manager = new WorkerConnectionManager();
  });

  afterEach(() => {
    manager.shutdown();
    cleanupTestEnv();
  });

  describe("Connection Lifecycle", () => {
    test("adds new connection and sends initial event", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      expect(manager.isConnected("worker-1")).toBe(true);
      expect(res.getWritten().length).toBeGreaterThan(0);

      // Parse SSE output
      const events = TestHelpers.parseSSE(res.getAllWrites());
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("connected");
      expect(events[0].data).toEqual({
        deploymentName: "worker-1",
        userId: "U123",
        conversationId: "thread-1",
      });
    });

    test("removes connection and ends response", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);
      expect(manager.isConnected("worker-1")).toBe(true);

      manager.removeConnection("worker-1");

      expect(manager.isConnected("worker-1")).toBe(false);
      expect(res.isEnded()).toBe(true);
    });

    test("ignores stale disconnect callbacks from replaced SSE writers", () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res1);
      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res2);

      manager.removeConnection("worker-1", res1);

      expect(manager.isConnected("worker-1")).toBe(true);
      expect(manager.getConnection("worker-1")?.writer).toBe(res2);

      manager.removeConnection("worker-1", res2);

      expect(manager.isConnected("worker-1")).toBe(false);
    });

    test("handles removing non-existent connection gracefully", () => {
      expect(() => manager.removeConnection("non-existent")).not.toThrow();
    });

    test("gets connection by deployment name", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const connection = manager.getConnection("worker-1");
      expect(connection).toBeDefined();
      expect(connection?.deploymentName).toBe("worker-1");
      expect(connection?.userId).toBe("U123");
      expect(connection?.conversationId).toBe("thread-1");
    });

    test("returns undefined for non-existent connection", () => {
      const connection = manager.getConnection("non-existent");
      expect(connection).toBeUndefined();
    });

    test("tracks multiple connections simultaneously", () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;
      const res3 = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res1);
      manager.addConnection("worker-2", "U456", "thread-2", "agent-2", res2);
      manager.addConnection("worker-3", "U789", "thread-3", "agent-3", res3);

      expect(manager.isConnected("worker-1")).toBe(true);
      expect(manager.isConnected("worker-2")).toBe(true);
      expect(manager.isConnected("worker-3")).toBe(true);

      const activeConnections = manager.getActiveConnections();
      expect(activeConnections).toHaveLength(3);
      expect(activeConnections).toContain("worker-1");
      expect(activeConnections).toContain("worker-2");
      expect(activeConnections).toContain("worker-3");
    });
  });

  describe("Connection Activity", () => {
    test("updates connection activity timestamp", async () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const conn1 = manager.getConnection("worker-1");
      const initialActivity = conn1?.lastActivity;

      // Wait a bit and touch
      await TestHelpers.delay(10);
      manager.touchConnection("worker-1");

      const conn2 = manager.getConnection("worker-1");
      expect(conn2?.lastActivity).toBeGreaterThan(initialActivity!);
    });

    test("handles touching non-existent connection gracefully", () => {
      expect(() => manager.touchConnection("non-existent")).not.toThrow();
    });
  });

  describe("SSE Event Sending", () => {
    test("sends SSE events with correct format", () => {
      const res = new MockResponse() as any;

      manager.sendSSE(res, "test-event", { key: "value" });

      const writes = res.getAllWrites();
      expect(writes).toContain("event: test-event\n");
      expect(writes).toContain('data: {"key":"value"}\n\n');
    });

    test("handles SSE send errors gracefully", () => {
      const badRes = {
        write: () => {
          throw new Error("Connection closed");
        },
      } as any;

      // Should not throw
      expect(() =>
        manager.sendSSE(badRes, "test", { data: "test" })
      ).not.toThrow();
    });

    test("sends complex data objects correctly", () => {
      const res = new MockResponse() as any;

      const complexData = {
        job: {
          id: "job-123",
          config: {
            model: "claude-3-5-sonnet",
            nested: { deep: true },
          },
        },
        timestamp: Date.now(),
      };

      manager.sendSSE(res, "job", complexData);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual(complexData);
    });
  });

  describe("Heartbeat Mechanism", () => {
    test("sends heartbeat pings to all connected workers", async () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res1);
      manager.addConnection("worker-2", "U456", "thread-2", "agent-2", res2);

      // Clear initial connection events
      res1.clearWrites();
      res2.clearWrites();

      // Wait for heartbeat (30s interval, but we can manually trigger for testing)
      // Instead, we'll test that heartbeats are sent by accessing the private method
      // This is a workaround since we can't wait 30s in tests
      (manager as any).sendHeartbeats();

      // Both workers should receive ping events
      const events1 = TestHelpers.parseSSE(res1.getAllWrites());
      const events2 = TestHelpers.parseSSE(res2.getAllWrites());

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);

      expect(events1[0].event).toBe("ping");
      expect(events2[0].event).toBe("ping");

      expect(events1[0].data).toHaveProperty("timestamp");
      expect(events2[0].data).toHaveProperty("timestamp");
    });

    test("updates lastPing timestamp after sending heartbeat", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const conn1 = manager.getConnection("worker-1");
      const initialPing = conn1?.lastPing;

      // Send heartbeat
      (manager as any).sendHeartbeats();

      const conn2 = manager.getConnection("worker-1");
      expect(conn2?.lastPing).toBeGreaterThanOrEqual(initialPing!);
    });

    test("continues heartbeat even if individual send fails", () => {
      const goodRes = new MockResponse() as any;
      const badRes = {
        write: () => {
          throw new Error("Connection failed");
        },
        end: () => {
          // noop
        },
        onClose: () => {
          // noop
        },
      } as any;

      manager.addConnection(
        "worker-good",
        "U123",
        "thread-1",
        "agent-1",
        goodRes
      );
      manager.addConnection(
        "worker-bad",
        "U456",
        "thread-2",
        "agent-2",
        badRes
      );

      goodRes.clearWrites();

      // Should not throw even if one connection fails
      expect(() => (manager as any).sendHeartbeats()).not.toThrow();

      // Good connection should still receive ping
      const events = TestHelpers.parseSSE(goodRes.getAllWrites());
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].event).toBe("ping");
    });
  });

  describe("Stale Connection Cleanup", () => {
    test("removes connections exceeding timeout threshold", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const connection = manager.getConnection("worker-1");
      if (connection) {
        // Simulate stale connection (11 minutes old, default timeout is 10 minutes)
        connection.lastActivity = Date.now() - 11 * 60 * 1000;
      }

      // Trigger cleanup
      (manager as any).cleanupStaleConnections();

      expect(manager.isConnected("worker-1")).toBe(false);
    });

    test("keeps connections within timeout threshold", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const connection = manager.getConnection("worker-1");
      if (connection) {
        // Simulate recent activity (9 minutes old, within 10 minute timeout)
        connection.lastActivity = Date.now() - 9 * 60 * 1000;
      }

      // Trigger cleanup
      (manager as any).cleanupStaleConnections();

      expect(manager.isConnected("worker-1")).toBe(true);
    });

    test("keeps connection alive after recent verified activity", async () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      const connection = manager.getConnection("worker-1");
      if (connection) {
        connection.lastActivity = Date.now() - 11 * 60 * 1000;
      }

      await TestHelpers.delay(10);
      manager.touchConnection("worker-1");

      (manager as any).cleanupStaleConnections();

      expect(manager.isConnected("worker-1")).toBe(true);
    });

    test("respects custom WORKER_STALE_TIMEOUT_MINUTES from env", () => {
      // Set custom timeout to 5 minutes
      process.env.WORKER_STALE_TIMEOUT_MINUTES = "5";

      const customManager = new WorkerConnectionManager();
      const res = new MockResponse() as any;

      customManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      const connection = customManager.getConnection("worker-1");
      if (connection) {
        // 6 minutes old (exceeds 5 minute custom timeout)
        connection.lastActivity = Date.now() - 6 * 60 * 1000;
      }

      // Trigger cleanup
      (customManager as any).cleanupStaleConnections();

      expect(customManager.isConnected("worker-1")).toBe(false);

      customManager.shutdown();
      delete process.env.WORKER_STALE_TIMEOUT_MINUTES;
    });

    test("cleans up only stale connections, keeps active ones", () => {
      const staleRes = new MockResponse() as any;
      const activeRes = new MockResponse() as any;

      manager.addConnection(
        "worker-stale",
        "U123",
        "thread-1",
        "agent-1",
        staleRes
      );
      manager.addConnection(
        "worker-active",
        "U456",
        "thread-2",
        "agent-2",
        activeRes
      );

      const staleConn = manager.getConnection("worker-stale");
      if (staleConn) {
        staleConn.lastActivity = Date.now() - 11 * 60 * 1000;
      }

      // Trigger cleanup
      (manager as any).cleanupStaleConnections();

      expect(manager.isConnected("worker-stale")).toBe(false);
      expect(manager.isConnected("worker-active")).toBe(true);
    });
  });

  describe("Shutdown", () => {
    test("clears heartbeat and cleanup intervals", () => {
      // Heartbeat and cleanup intervals are set in constructor
      // After shutdown, they should be cleared
      manager.shutdown();

      // Create new connection after shutdown shouldn't have active intervals
      // This is hard to test directly, but we can verify no errors occur
      expect(() => manager.shutdown()).not.toThrow();
    });

    test("closes all active connections", () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;
      const res3 = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res1);
      manager.addConnection("worker-2", "U456", "thread-2", "agent-2", res2);
      manager.addConnection("worker-3", "U789", "thread-3", "agent-3", res3);

      manager.shutdown();

      expect(manager.isConnected("worker-1")).toBe(false);
      expect(manager.isConnected("worker-2")).toBe(false);
      expect(manager.isConnected("worker-3")).toBe(false);

      expect(res1.isEnded()).toBe(true);
      expect(res2.isEnded()).toBe(true);
      expect(res3.isEnded()).toBe(true);
    });

    test("shutdown is idempotent", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);

      manager.shutdown();
      manager.shutdown(); // Call twice

      expect(manager.isConnected("worker-1")).toBe(false);
    });
  });

  describe("Error Handling", () => {
    test("handles connection removal when response already ended", () => {
      const res = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res);
      res.end(); // End response manually

      // Should not throw when removing
      expect(() => manager.removeConnection("worker-1")).not.toThrow();
    });

    test("handles malformed data in SSE gracefully", () => {
      const res = new MockResponse() as any;

      // Circular reference should be handled
      const circular: any = { a: 1 };
      circular.self = circular;

      // Should handle gracefully (JSON.stringify will throw, but sendSSE catches it)
      expect(() => manager.sendSSE(res, "test", circular)).not.toThrow();
    });
  });

  describe("Active Connections Tracking", () => {
    test("returns empty array when no connections", () => {
      const activeConnections = manager.getActiveConnections();
      expect(activeConnections).toEqual([]);
    });

    test("returns all active connection names", () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;

      manager.addConnection(
        "worker-alpha",
        "U123",
        "thread-1",
        "agent-1",
        res1
      );
      manager.addConnection("worker-beta", "U456", "thread-2", "agent-2", res2);

      const activeConnections = manager.getActiveConnections();
      expect(activeConnections).toHaveLength(2);
      expect(activeConnections).toContain("worker-alpha");
      expect(activeConnections).toContain("worker-beta");
    });

    test("updates active connections list after removal", () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;

      manager.addConnection("worker-1", "U123", "thread-1", "agent-1", res1);
      manager.addConnection("worker-2", "U456", "thread-2", "agent-2", res2);

      expect(manager.getActiveConnections()).toHaveLength(2);

      manager.removeConnection("worker-1");

      const activeConnections = manager.getActiveConnections();
      expect(activeConnections).toHaveLength(1);
      expect(activeConnections).toContain("worker-2");
      expect(activeConnections).not.toContain("worker-1");
    });
  });
});
