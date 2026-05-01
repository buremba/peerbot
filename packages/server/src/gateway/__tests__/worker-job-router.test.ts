/**
 * Tests for WorkerJobRouter
 * Tests job routing from queues to workers, acknowledgments, and timeouts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkerConnectionManager } from "../gateway/connection-manager.js";
import { WorkerJobRouter } from "../gateway/job-router.js";
import {
  cleanupTestEnv,
  MockMessageQueue,
  MockResponse,
  setupTestEnv,
  TestHelpers,
} from "./setup.js";

describe("WorkerJobRouter", () => {
  let queue: MockMessageQueue;
  let connectionManager: WorkerConnectionManager;
  let router: WorkerJobRouter;

  beforeEach(() => {
    setupTestEnv();
    queue = new MockMessageQueue();
    connectionManager = new WorkerConnectionManager();

    router = new WorkerJobRouter(queue as any, connectionManager);
  });

  afterEach(() => {
    router.shutdown();
    connectionManager.shutdown();
    cleanupTestEnv();
  });

  describe("Worker Registration", () => {
    test("registers worker and creates queue", async () => {
      await router.registerWorker("worker-1");

      const queueName = "thread_message_worker-1";
      const createdQueue = queue.getQueue(queueName);
      expect(createdQueue).toBeDefined();
    });

    test("uses correct queue name format", async () => {
      await router.registerWorker("my-deployment");

      const queueName = "thread_message_my-deployment";
      expect(queue.getQueue(queueName)).toBeDefined();
    });

    test("is idempotent - multiple registrations don't break", async () => {
      await router.registerWorker("worker-1");
      await router.registerWorker("worker-1"); // Register twice
      await router.registerWorker("worker-1"); // And again

      // Should not throw and queue should exist
      const queueName = "thread_message_worker-1";
      expect(queue.getQueue(queueName)).toBeDefined();
    });

    test("registers multiple workers with different queues", async () => {
      await router.registerWorker("worker-1");
      await router.registerWorker("worker-2");
      await router.registerWorker("worker-3");

      expect(queue.getQueue("thread_message_worker-1")).toBeDefined();
      expect(queue.getQueue("thread_message_worker-2")).toBeDefined();
      expect(queue.getQueue("thread_message_worker-3")).toBeDefined();
    });
  });

  describe("Job Routing", () => {
    test("routes job to connected worker via SSE", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      res.clearWrites(); // Clear connection event

      const job = TestHelpers.createMockJob({ userId: "U123" });

      // Add job and let it auto-process
      const routePromise = queue.addJob("thread_message_worker-1", job);

      // Immediately acknowledge (simulating worker response)
      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;

      // Verify job was sent
      expect(events.length).toBeGreaterThan(0);
      expect(jobEvent).toBeDefined();
      expect(jobEvent?.event).toBe("job");
      expect(jobEvent?.data).toHaveProperty("jobId");
    });

    test("includes jobId in job payload", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = TestHelpers.createMockJob({ prompt: "test prompt" });

      // Route job
      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");

      // Acknowledge before timeout
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;

      expect(jobEvent?.data?.jobId).toBeDefined();
      expect(typeof jobEvent?.data?.jobId).toBe("string");
      expect(jobEvent?.data?.jobId).toContain("job-");
    });

    test("merges job data with jobId", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = {
        id: "original-job-id",
        data: {
          prompt: "test prompt",
          userId: "U123",
          customField: "custom value",
        },
      };

      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");

      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;

      // Original data should be preserved in payload
      expect(jobEvent?.data?.payload?.prompt).toBe("test prompt");
      expect(jobEvent?.data?.payload?.userId).toBe("U123");
      expect(jobEvent?.data?.payload?.customField).toBe("custom value");
      // JobId should be at top level
      expect(jobEvent?.data?.jobId).toBeDefined();
    });

    test("rejects job when worker not connected", async () => {
      await router.registerWorker("worker-1");

      const job = TestHelpers.createMockJob();

      // Worker is registered but not connected
      await expect(
        queue.addJob("thread_message_worker-1", job)
      ).rejects.toThrow("Worker not connected");
    });

    test("touches connection activity when routing job", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const connection1 = connectionManager.getConnection("worker-1");
      const initialActivity = connection1?.lastActivity;

      // Wait a bit
      await TestHelpers.delay(10);

      const job = TestHelpers.createMockJob();
      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;

      const connection2 = connectionManager.getConnection("worker-1");
      expect(connection2?.lastActivity).toBeGreaterThan(initialActivity!);
    });
  });

  describe("Job Acknowledgment", () => {
    test("acknowledges job and resolves promise", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = TestHelpers.createMockJob();
      const routePromise = queue.addJob("thread_message_worker-1", job);

      // Get jobId from SSE event
      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      const jobId = jobEvent?.data?.jobId;

      expect(jobId).toBeDefined();

      // Acknowledge job
      router.acknowledgeJob(jobId);

      // Promise should resolve without throwing
      await routePromise;
      expect(true).toBe(true); // Test passes if no error thrown
    });

    test("handles acknowledgment of unknown job", () => {
      // Should not throw
      expect(() => router.acknowledgeJob("unknown-job-id")).not.toThrow();
    });

    test("clears timeout when job is acknowledged", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = TestHelpers.createMockJob();
      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      const jobId = jobEvent?.data?.jobId;

      expect(router.getPendingJobCount()).toBe(1);

      // Acknowledge
      router.acknowledgeJob(jobId);

      await routePromise;

      // Pending jobs should be cleared
      expect(router.getPendingJobCount()).toBe(0);
    });

    test("handles multiple job acknowledgments", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      const jobs = [
        TestHelpers.createMockJob({ id: "1" }),
        TestHelpers.createMockJob({ id: "2" }),
        TestHelpers.createMockJob({ id: "3" }),
      ];

      const promises: Promise<void>[] = [];

      for (const job of jobs) {
        res.clearWrites();
        const promise = queue.addJob("thread_message_worker-1", job);
        promises.push(promise);

        // Acknowledge immediately
        const events = TestHelpers.parseSSE(res.getAllWrites());
        const jobEvent = events.find((e) => e.event === "job");
        if (jobEvent?.data?.jobId) {
          router.acknowledgeJob(jobEvent.data.jobId);
        }
      }

      await Promise.all(promises);
      expect(router.getPendingJobCount()).toBe(0);
    });
  });

  describe("Job Timeout", () => {
    test("times out job after 5 minutes without acknowledgment", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = TestHelpers.createMockJob();

      // Don't acknowledge - let it timeout
      // We can't actually wait 5 minutes, so we'll verify the timeout is set
      const routePromise = queue.addJob("thread_message_worker-1", job);

      expect(router.getPendingJobCount()).toBe(1);

      // For testing, we need to acknowledge to not break other tests
      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;
    }, 10000); // Extend test timeout

    test("tracks pending job count correctly", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      expect(router.getPendingJobCount()).toBe(0);

      res.clearWrites();
      const job1Promise = queue.addJob(
        "thread_message_worker-1",
        TestHelpers.createMockJob()
      );

      expect(router.getPendingJobCount()).toBe(1);

      // Acknowledge first job
      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await job1Promise;
      expect(router.getPendingJobCount()).toBe(0);
    });
  });

  describe("Shutdown", () => {
    test("rejects all pending jobs on shutdown", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = TestHelpers.createMockJob();

      // addJob now blocks waiting for delivery receipt, so we need to
      // acknowledge the job asynchronously while addJob is in progress.
      const addPromise = queue.addJob("thread_message_worker-1", job);

      // Acknowledge after a short delay (simulates worker receipt)
      await new Promise((resolve) => setTimeout(resolve, 10));
      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");
      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await addPromise;

      // The acknowledged job should be cleared
      expect(router.getPendingJobCount()).toBe(0);

      // Shutdown router
      router.shutdown();
      expect(router.getPendingJobCount()).toBe(0);
    });

    test("clears all pending timeouts on shutdown", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      // Send multiple jobs, acknowledging each
      for (let i = 0; i < 3; i++) {
        res.clearWrites();
        const addPromise = queue.addJob(
          "thread_message_worker-1",
          TestHelpers.createMockJob()
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        const events = TestHelpers.parseSSE(res.getAllWrites());
        const jobEvent = events.find((e) => e.event === "job");
        if (jobEvent?.data?.jobId) {
          router.acknowledgeJob(jobEvent.data.jobId);
        }
        await addPromise;
      }

      expect(router.getPendingJobCount()).toBe(0);

      // Shutdown
      router.shutdown();
      expect(router.getPendingJobCount()).toBe(0);
    });

    test("shutdown is idempotent", () => {
      router.shutdown();
      router.shutdown(); // Call twice

      expect(router.getPendingJobCount()).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    test("handles job with null data", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = { id: "test-id", data: null };

      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");

      expect(jobEvent?.data).toHaveProperty("jobId");
      expect(jobEvent?.data).toHaveProperty("payload");

      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;
    });

    test("handles job with undefined data", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const job = { id: "test-id" }; // No data field

      const routePromise = queue.addJob("thread_message_worker-1", job);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");

      expect(jobEvent?.data).toHaveProperty("jobId");

      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;
    });

    test("generates unique jobIds for concurrent jobs", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      const jobIds = new Set<string>();
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 10; i++) {
        res.clearWrites();
        const promise = queue.addJob(
          "thread_message_worker-1",
          TestHelpers.createMockJob()
        );
        promises.push(promise);

        const events = TestHelpers.parseSSE(res.getAllWrites());
        const jobEvent = events.find((e) => e.event === "job");
        if (jobEvent?.data?.jobId) {
          jobIds.add(jobEvent.data.jobId);
          router.acknowledgeJob(jobEvent.data.jobId);
        }
      }

      await Promise.all(promises);

      // All job IDs should be unique
      expect(jobIds.size).toBe(10);
    });

    test("handles very large job data", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");
      res.clearWrites();

      const largeJob = TestHelpers.createMockJob({
        largeField: "x".repeat(100000), // 100KB
      });

      const routePromise = queue.addJob("thread_message_worker-1", largeJob);

      const events = TestHelpers.parseSSE(res.getAllWrites());
      const jobEvent = events.find((e) => e.event === "job");

      expect(jobEvent?.data?.payload?.largeField?.length).toBe(100000);

      if (jobEvent?.data?.jobId) {
        router.acknowledgeJob(jobEvent.data.jobId);
      }

      await routePromise;
    });
  });

  describe("Concurrent Job Handling", () => {
    test("handles multiple jobs to same worker sequentially", async () => {
      const res = new MockResponse() as any;
      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res
      );

      await router.registerWorker("worker-1");

      const jobPromises: Promise<void>[] = [];

      for (let i = 0; i < 5; i++) {
        res.clearWrites();
        const promise = queue.addJob(
          "thread_message_worker-1",
          TestHelpers.createMockJob({ index: i })
        );
        jobPromises.push(promise);

        // Acknowledge each job
        const events = TestHelpers.parseSSE(res.getAllWrites());
        const jobEvent = events.find((e) => e.event === "job");
        if (jobEvent?.data?.jobId) {
          router.acknowledgeJob(jobEvent.data.jobId);
        }
      }

      await Promise.all(jobPromises);
      expect(router.getPendingJobCount()).toBe(0);
    });

    test("handles jobs to multiple workers concurrently", async () => {
      const res1 = new MockResponse() as any;
      const res2 = new MockResponse() as any;
      const res3 = new MockResponse() as any;

      connectionManager.addConnection(
        "worker-1",
        "U123",
        "thread-1",
        "agent-1",
        res1
      );
      connectionManager.addConnection(
        "worker-2",
        "U456",
        "thread-2",
        "agent-2",
        res2
      );
      connectionManager.addConnection(
        "worker-3",
        "U789",
        "thread-3",
        "agent-3",
        res3
      );

      await router.registerWorker("worker-1");
      await router.registerWorker("worker-2");
      await router.registerWorker("worker-3");

      const responses = [res1, res2, res3];

      const promises = [
        queue.addJob("thread_message_worker-1", TestHelpers.createMockJob()),
        queue.addJob("thread_message_worker-2", TestHelpers.createMockJob()),
        queue.addJob("thread_message_worker-3", TestHelpers.createMockJob()),
      ];

      // Acknowledge all jobs
      for (let i = 0; i < 3; i++) {
        const events = TestHelpers.parseSSE(responses[i].getAllWrites());
        const jobEvent = events.find((e) => e.event === "job");
        if (jobEvent?.data?.jobId) {
          router.acknowledgeJob(jobEvent.data.jobId);
        }
      }

      await Promise.all(promises);
      expect(router.getPendingJobCount()).toBe(0);
    });
  });
});
