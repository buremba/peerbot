import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import type { MessagePayload } from "../infrastructure/queue/queue-producer";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type OrchestratorConfig,
} from "../orchestration/base-deployment-manager";
import { GrantStore } from "../permissions/grant-store";

/** Minimal concrete subclass — only exists so we can test grant syncing. */
class TestDeploymentManager extends BaseDeploymentManager {
  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }
  protected async spawnDeployment(): Promise<void> {
    /* noop */
  }
  async scaleDeployment(): Promise<void> {
    /* noop */
  }
  async deleteDeployment(): Promise<void> {
    /* noop */
  }
  async updateDeploymentActivity(): Promise<void> {
    /* noop */
  }
  async validateWorkerImage(): Promise<void> {
    /* noop */
  }
  protected getDispatcherHost(): string {
    return "localhost";
  }
}

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
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

function buildPayload(overrides: Partial<MessagePayload>): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m",
    channelId: "ch",
    teamId: "t",
    agentId: "agent-1",
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

describe("BaseDeploymentManager.syncNetworkConfigGrants", () => {
  let redis: MockRedisClient;
  let grantStore: GrantStore;
  let manager: TestDeploymentManager;

  beforeEach(() => {
    redis = new MockRedisClient();
    grantStore = new GrantStore(redis);
    manager = new TestDeploymentManager(TEST_CONFIG);
    manager.setGrantStore(grantStore);
  });

  test("syncs networkConfig.allowedDomains into the grant store", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com", ".github.com"],
        },
      })
    );

    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(true);
    expect(await grantStore.hasGrant("agent-1", ".github.com")).toBe(true);
  });

  test("syncs preApprovedTools as MCP tool grants", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        preApprovedTools: [
          "/mcp/gmail/tools/list_messages",
          "/mcp/linear/tools/*",
        ],
      })
    );

    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/list_messages")
    ).toBe(true);
    // Wildcard pattern should match a specific tool under it.
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/linear/tools/create_issue")
    ).toBe(true);
  });

  test("syncs both network and pre-approved tools in one call", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(true);
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
    ).toBe(true);
  });

  test("no-op when grantStore is not set", async () => {
    const barebones = new TestDeploymentManager(TEST_CONFIG);
    // Does not throw, nothing to assert against.
    await barebones.syncNetworkConfigGrants(
      buildPayload({
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );
  });

  test("skips redundant writes when the pattern set has not changed", async () => {
    const grantSpy = spyOn(grantStore, "grant");
    const payload = buildPayload({
      networkConfig: { allowedDomains: ["api.example.com"] },
      preApprovedTools: ["/mcp/gmail/tools/send_email"],
    });

    await manager.syncNetworkConfigGrants(payload);
    const callsAfterFirst = grantSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(2);

    // Second call with identical patterns — should be a no-op.
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst);

    // Same patterns in a different order — still a no-op.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst);

    // Adding a new pattern only grants the new one, leaves old alone.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: [
          "/mcp/gmail/tools/send_email",
          "/mcp/gmail/tools/list_messages",
        ],
      })
    );
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  test("revokes patterns removed from the agent's config", async () => {
    const revokeSpy = spyOn(grantStore, "revoke");

    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com", ".github.com"],
        },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(true);
    expect(await grantStore.hasGrant("agent-1", ".github.com")).toBe(true);
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
    ).toBe(true);

    // Shrink the set: drop the second domain and the MCP tool grant.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
      })
    );

    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(true);
    expect(await grantStore.hasGrant("agent-1", ".github.com")).toBe(false);
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
    ).toBe(false);
  });

  test("invalidateGrantSyncCache forces the next call to re-sync", async () => {
    // Simulates the reload-from-files flow: an operator changes
    // `networkConfig.allowedDomains` on disk, calls `reloadFromFiles`, and
    // the next message should re-grant even if the cached hash says the
    // set is unchanged.
    const grantSpy = spyOn(grantStore, "grant");

    const payload = buildPayload({
      networkConfig: { allowedDomains: ["api.example.com"] },
    });

    await manager.syncNetworkConfigGrants(payload);
    const firstCallCount = grantSpy.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Identical second call → cache hit → no new writes.
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(firstCallCount);

    // Invalidate and re-sync: the manager should re-grant even though
    // nothing in the payload changed.
    manager.invalidateGrantSyncCache("agent-1");
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(firstCallCount + 1);
  });

  test("revokes all grants when the config is cleared entirely", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(true);
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
    ).toBe(true);

    // Operator clears both lists.
    await manager.syncNetworkConfigGrants(buildPayload({}));

    expect(await grantStore.hasGrant("agent-1", "api.example.com")).toBe(false);
    expect(
      await grantStore.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
    ).toBe(false);
  });
});

/**
 * In-flight coalescing for `ensureDeployment` lives in the base class so all
 * orchestrators share one implementation. Subclass-specific concerns (Docker
 * 409, K8s AlreadyExists, embedded `workers.has` short-circuit) are tested
 * separately in their own files.
 */
describe("BaseDeploymentManager.ensureDeployment in-flight coalescing", () => {
  class CountingManager extends BaseDeploymentManager {
    spawnCalls = 0;
    /** Resolver for the most recent spawn — lets tests hold spawn open. */
    releaseSpawn: () => void = () => {
      // replaced by each test before spawn runs
    };

    async listDeployments(): Promise<DeploymentInfo[]> {
      return [];
    }
    protected async spawnDeployment(): Promise<void> {
      this.spawnCalls++;
      await new Promise<void>((resolve) => {
        this.releaseSpawn = resolve;
      });
    }
    async scaleDeployment(): Promise<void> {
      /* noop */
    }
    async deleteDeployment(): Promise<void> {
      /* noop */
    }
    async updateDeploymentActivity(): Promise<void> {
      /* noop */
    }
    async validateWorkerImage(): Promise<void> {
      /* noop */
    }
    protected getDispatcherHost(): string {
      return "localhost";
    }
  }

  test("concurrent calls for the same name share a single spawn", async () => {
    const manager = new CountingManager(TEST_CONFIG);

    const p1 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));
    const p2 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));
    const p3 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));

    // All three callers are blocked on the single in-flight spawn.
    expect(manager.spawnCalls).toBe(1);

    manager.releaseSpawn();
    await Promise.all([p1, p2, p3]);

    expect(manager.spawnCalls).toBe(1);
  });

  test("concurrent calls for different names spawn independently", async () => {
    const manager = new CountingManager(TEST_CONFIG);

    const p1 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));
    // Capture the first spawn's resolver before the second call overwrites it.
    const release1 = manager.releaseSpawn;
    const p2 = manager.ensureDeployment("worker-2", "u", "u", buildPayload({}));
    const release2 = manager.releaseSpawn;

    expect(manager.spawnCalls).toBe(2);

    release1();
    release2();
    await Promise.all([p1, p2]);
  });

  test("after spawn resolves, a subsequent call re-spawns (cache cleared)", async () => {
    const manager = new CountingManager(TEST_CONFIG);

    const p1 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));
    manager.releaseSpawn();
    await p1;
    expect(manager.spawnCalls).toBe(1);

    // The base class only dedupes in-flight work — once it settles, a fresh
    // call re-invokes spawn. Subclasses are responsible for their own
    // post-completion idempotency (e.g. embedded's `workers.has` guard).
    const p2 = manager.ensureDeployment("worker-1", "u", "u", buildPayload({}));
    manager.releaseSpawn();
    await p2;
    expect(manager.spawnCalls).toBe(2);
  });

  test("rejected spawn clears the in-flight entry so the next call retries", async () => {
    class FailingManager extends BaseDeploymentManager {
      attempts = 0;
      async listDeployments(): Promise<DeploymentInfo[]> {
        return [];
      }
      protected async spawnDeployment(): Promise<void> {
        this.attempts++;
        if (this.attempts === 1) {
          throw new Error("transient");
        }
      }
      async scaleDeployment(): Promise<void> {
        /* noop */
      }
      async deleteDeployment(): Promise<void> {
        /* noop */
      }
      async updateDeploymentActivity(): Promise<void> {
        /* noop */
      }
      async validateWorkerImage(): Promise<void> {
        /* noop */
      }
      protected getDispatcherHost(): string {
        return "localhost";
      }
    }

    const manager = new FailingManager(TEST_CONFIG);
    await expect(
      manager.ensureDeployment("worker-1", "u", "u", buildPayload({}))
    ).rejects.toThrow("transient");
    await expect(
      manager.ensureDeployment("worker-1", "u", "u", buildPayload({}))
    ).resolves.toBeUndefined();
    expect(manager.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Known coverage gap: K8sDeploymentManager
// ---------------------------------------------------------------------------
//
// There is currently NO test file for `orchestration/impl/k8s/deployment.ts`.
// As a result, the following recently-added behavior is unverified by tests:
//
//   1. The `409 AlreadyExists` short-circuit added in `spawnDeployment`
//      (treats concurrent multi-replica creates as benign success and returns
//      without touching the PVC).
//   2. The PVC creation / cleanup paths in general.
//   3. The deployment env / pod-spec construction.
//
// In production this path is covered only by manual smoke tests via
// `make deploy` against a real cluster. Adding a `@kubernetes/client-node`
// mock layer is non-trivial (the SDK uses class-based watchers and dynamic
// API discovery), so coverage here was deferred. Track this gap before any
// further changes to k8s/deployment.ts.
