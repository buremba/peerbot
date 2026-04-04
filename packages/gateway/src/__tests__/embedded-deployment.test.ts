import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ErrorCode, OrchestratorError } from "@lobu/core";
import type {
  MessagePayload,
  OrchestratorConfig,
} from "../orchestration/base-deployment-manager";

// ---------------------------------------------------------------------------
// Mock child_process.spawn to return a fake ChildProcess
// ---------------------------------------------------------------------------
const mockChildProcesses: EventEmitter[] = [];
const mockSpawn = mock(() => createMockChildProcess());

function createMockChildProcess() {
  const cp = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof mock>;
  };
  cp.pid = Math.floor(Math.random() * 100000);
  cp.exitCode = null;
  cp.killed = false;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = mock((signal?: string) => {
    cp.killed = true;
    cp.exitCode = signal === "SIGKILL" ? 137 : 0;
    cp.emit("exit", cp.exitCode, signal);
    return true;
  });
  mockChildProcesses.push(cp);
  return cp;
}

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Now import the class under test
// ---------------------------------------------------------------------------
import { EmbeddedDeploymentManager } from "../orchestration/impl/embedded-deployment";

// ---------------------------------------------------------------------------
// Test config & helpers
// ---------------------------------------------------------------------------
const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_CONFIG: OrchestratorConfig = {
  queues: {
    connectionString: "redis://localhost:6379",
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 300,
  },
  worker: {
    image: {
      repository: "lobu-worker",
      tag: "latest",
      pullPolicy: "IfNotPresent",
    },
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    idleCleanupMinutes: 30,
    maxDeployments: 10,
  },
  kubernetes: { namespace: "default" },
  cleanup: {
    initialDelayMs: 5000,
    intervalMs: 60000,
    veryOldDays: 7,
  },
};

function createTestMessagePayload(
  overrides?: Partial<MessagePayload>
): MessagePayload {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    channelId: "ch-1",
    messageId: "msg-1",
    teamId: "team-1",
    agentId: "test-agent",
    botId: "bot-1",
    platform: "slack",
    messageText: "hello",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  } as MessagePayload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("EmbeddedDeploymentManager", () => {
  let manager: EmbeddedDeploymentManager;
  let mkdirSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    manager = new EmbeddedDeploymentManager(TEST_CONFIG);
    mockChildProcesses.length = 0;
    mockSpawn.mockClear();
    mkdirSyncSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
  });

  afterEach(() => {
    mkdirSyncSpy.mockRestore();
  });

  // =========================================================================
  // validateWorkerImage
  // =========================================================================
  describe("validateWorkerImage", () => {
    test("succeeds when worker entry point exists", async () => {
      const spy = spyOn(fs, "existsSync").mockReturnValue(true);
      await expect(manager.validateWorkerImage()).resolves.toBeUndefined();
      spy.mockRestore();
    });

    test("throws when worker entry point does not exist", async () => {
      const spy = spyOn(fs, "existsSync").mockReturnValue(false);
      try {
        await manager.validateWorkerImage();
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(OrchestratorError);
        expect((err as OrchestratorError).code).toBe(
          ErrorCode.DEPLOYMENT_CREATE_FAILED
        );
        expect((err as Error).message).toContain(
          "Worker entry point not found"
        );
      }
      spy.mockRestore();
    });
  });

  // =========================================================================
  // Lifecycle: create / list / scale / delete
  // =========================================================================
  describe("lifecycle", () => {
    test("createDeployment then listDeployments returns 1 entry", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(1);
      expect(list[0].deploymentName).toBe("worker-1");
      expect(list[0].replicas).toBe(1);
    });

    test("createDeployment spawns a child process", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      expect(mockChildProcesses).toHaveLength(1);
      expect(mockChildProcesses[0]).toBeDefined();
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(process.execPath);
    });

    test("createDeployment with different names returns multiple entries", async () => {
      const msg1 = createTestMessagePayload({ agentId: "agent-a" });
      const msg2 = createTestMessagePayload({
        agentId: "agent-b",
        conversationId: "conv-2",
      });
      await manager.createDeployment("worker-1", "user-1", "user-1", msg1);
      await manager.createDeployment("worker-2", "user-1", "user-1", msg2);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(2);
    });

    test("scaleDeployment(0) kills worker and removes from map", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      await manager.scaleDeployment("worker-1", 0);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });

    test("deleteDeployment kills process and removes entry", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      await manager.deleteDeployment("worker-1");
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });

    test("deleteDeployment on non-existent name is a no-op", async () => {
      await expect(
        manager.deleteDeployment("nonexistent")
      ).resolves.toBeUndefined();
    });

    test("scaleDeployment on non-existent name does not crash", async () => {
      await expect(
        manager.scaleDeployment("nonexistent", 0)
      ).resolves.toBeUndefined();
      await expect(
        manager.scaleDeployment("nonexistent", 1)
      ).resolves.toBeUndefined();
    });

    test("listDeployments returns empty when no workers exist", async () => {
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });
  });

  // =========================================================================
  // Activity tracking
  // =========================================================================
  describe("activity tracking", () => {
    test("lastActivity is set at creation time", async () => {
      const before = Date.now();
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      const after = Date.now();
      const list = await manager.listDeployments();
      const ts = list[0].lastActivity.getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    test("updateDeploymentActivity advances timestamp", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      const listBefore = await manager.listDeployments();
      const tsBefore = listBefore[0].lastActivity.getTime();

      await new Promise((r) => setTimeout(r, 10));

      await manager.updateDeploymentActivity("worker-1");
      const listAfter = await manager.listDeployments();
      const tsAfter = listAfter[0].lastActivity.getTime();
      expect(tsAfter).toBeGreaterThan(tsBefore);
    });

    test("updateDeploymentActivity on non-existent is a no-op", async () => {
      await expect(
        manager.updateDeploymentActivity("nonexistent")
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Subprocess-specific behavior
  // =========================================================================
  describe("subprocess behavior", () => {
    test("does not mutate gateway process.env", async () => {
      const envBefore = { ...process.env };
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      // Gateway process.env should not have new worker-specific vars added
      // (WORKSPACE_DIR, WORKER_TOKEN, etc. are passed to subprocess env, not process.env)
      expect(process.env.WORKSPACE_DIR).toBe(envBefore.WORKSPACE_DIR);
      expect(process.env.WORKER_TOKEN).toBe(envBefore.WORKER_TOKEN);
      expect(process.env.USER_ID).toBe(envBefore.USER_ID);
      expect(process.env.CONVERSATION_ID).toBe(envBefore.CONVERSATION_ID);
    });

    test("does not set globalThis.__lobuEmbeddedBashOps", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      expect((globalThis as any).__lobuEmbeddedBashOps).toBeUndefined();
    });

    test("prepends the worker bin directory to subprocess PATH", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);

      const spawnCall = mockSpawn.mock.calls.at(-1);
      expect(spawnCall).toBeDefined();

      const spawnOptions = spawnCall?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      const pathEntries = (spawnOptions?.env?.PATH || "").split(":");
      expect(pathEntries).toContain(path.resolve("node_modules/.bin"));
    });

    test("child process exit removes worker from map", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      expect(await manager.listDeployments()).toHaveLength(1);

      // Simulate child process exiting
      const cp = mockChildProcesses[0];
      cp.emit("exit", 1, null);

      // Give the event handler a tick to run
      await new Promise((r) => setTimeout(r, 0));

      expect(await manager.listDeployments()).toHaveLength(0);
    });
  });

  // =========================================================================
  // listDeployments shape
  // =========================================================================
  describe("listDeployments shape", () => {
    test("returns DeploymentInfo with expected fields", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      const info = list[0];
      expect(info.deploymentName).toBe("worker-1");
      expect(info.replicas).toBe(1);
      expect(info.lastActivity).toBeInstanceOf(Date);
      expect(typeof info.minutesIdle).toBe("number");
      expect(typeof info.daysSinceActivity).toBe("number");
      expect(typeof info.isIdle).toBe("boolean");
      expect(typeof info.isVeryOld).toBe("boolean");
    });

    test("newly created worker is not idle", async () => {
      const msg = createTestMessagePayload();
      await manager.createDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      expect(list[0].isIdle).toBe(false);
      expect(list[0].isVeryOld).toBe(false);
    });
  });
});
