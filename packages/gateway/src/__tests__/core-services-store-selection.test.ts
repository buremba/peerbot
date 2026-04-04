import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayConfig } from "../config";
import { CoreServices } from "../services/core-services";
import { MockMessageQueue } from "./setup";
import {
  RedisAgentAccessStore,
  RedisAgentConfigStore,
  RedisAgentConnectionStore,
} from "../stores/redis-agent-store";

function createGatewayConfig(
  overrides?: Partial<GatewayConfig>
): GatewayConfig {
  return {
    agentDefaults: {},
    sessionTimeoutMinutes: 5,
    logLevel: "INFO",
    queues: {
      connectionString: "redis://test",
      directMessage: "direct_message",
      messageQueue: "message_queue",
      retryLimit: 3,
      retryDelay: 1,
      expireInHours: 24,
    },
    anthropicProxy: {
      enabled: true,
    },
    orchestration: {
      deploymentMode: "docker",
      queues: {
        connectionString: "redis://test",
        retryLimit: 3,
        retryDelay: 1,
        expireInSeconds: 3600,
      },
      worker: {
        image: {
          repository: "lobu-worker",
          tag: "latest",
          digest: "",
          pullPolicy: "Always",
        },
        imagePullSecrets: [],
        serviceAccountName: "lobu-worker",
        runtimeClassName: "",
        startupTimeoutSeconds: 90,
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "1000m", memory: "2Gi" },
        },
        idleCleanupMinutes: 60,
        maxDeployments: 100,
      },
      kubernetes: { namespace: "lobu" },
      cleanup: {
        initialDelayMs: 1000,
        intervalMs: 60000,
        veryOldDays: 7,
      },
    },
    mcp: {
      publicGatewayUrl: "http://localhost:8080",
      internalGatewayUrl: "http://gateway:8080",
    },
    health: {
      checkIntervalMs: 1000,
      staleThresholdMs: 2000,
      protectActiveWorkers: true,
    },
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.LOBU_WORKSPACE_ROOT;
});

describe("CoreServices store selection", () => {
  test("uses Redis-backed stores by default when no file-first config is present", async () => {
    const coreServices = new CoreServices(createGatewayConfig());
    (coreServices as any).queue = new MockMessageQueue();

    await (coreServices as any).initializeSessionServices();

    expect(coreServices.getConfigStore()).toBeInstanceOf(RedisAgentConfigStore);
    expect(coreServices.getConnectionStore()).toBeInstanceOf(
      RedisAgentConnectionStore
    );
    expect(coreServices.getAccessStore()).toBeInstanceOf(RedisAgentAccessStore);
  });
});
