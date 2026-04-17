import { afterEach, describe, expect, test } from "bun:test";
import type { SecretPutOptions, SecretRef } from "@lobu/core";
import type { GatewayConfig } from "../config";
import { CoreServices } from "../services/core-services";
import {
  type SecretListEntry,
  SecretStoreRegistry,
  type WritableSecretStore,
} from "../secrets";
import {
  RedisAgentAccessStore,
  RedisAgentConfigStore,
  RedisAgentConnectionStore,
} from "../stores/redis-agent-store";
import { MockMessageQueue } from "./setup";

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
    secrets: {
      redis: { prefix: "lobu:test:secret-store:" },
      aws: {},
    },
    ...overrides,
  };
}

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  constructor(private readonly scheme: string = "host") {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) {
      return null;
    }

    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }

  async put(
    name: string,
    value: string,
    _options?: SecretPutOptions
  ): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith(`${this.scheme}://`)
      ? decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length))
      : nameOrRef;
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const entries: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) {
        continue;
      }

      entries.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.scheme,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return entries;
  }
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

  test("uses the host-provided secret store for persisted auth profiles", async () => {
    const hostStore = new InMemoryWritableStore();
    const hostRegistry = new SecretStoreRegistry(hostStore, {
      host: hostStore,
    });
    const coreServices = new CoreServices(createGatewayConfig(), {
      secretStore: hostRegistry,
    });
    (coreServices as any).queue = new MockMessageQueue();

    await (coreServices as any).initializeSessionServices();
    await (coreServices as any).initializeClaudeServices();

    const authProfilesManager = coreServices.getAuthProfilesManager();
    expect(authProfilesManager).toBeDefined();
    await authProfilesManager!.upsertProfile({
      agentId: "agent-1",
      userId: "user-1",
      provider: "openai",
      credential: "sk-host-store-only",
      label: "host-backed",
      authType: "api-key",
    });

    const redis = (coreServices as any).queue.getRedisClient();
    const rawProfiles = await redis.get("user:auth-profiles:user-1:agent-1");
    expect(rawProfiles).toContain("host://");

    const [, redisSecretKeys] = await redis.scan(
      "0",
      "MATCH",
      "lobu:test:secret-store:*"
    );
    expect(redisSecretKeys).toHaveLength(0);

    const hostEntries = await hostStore.list(
      "users/user-1/agents/agent-1/auth-profiles/"
    );
    expect(hostEntries).toHaveLength(1);
    expect(await hostStore.get(hostEntries[0]!.ref)).toBe("sk-host-store-only");
  });
});

describe("CoreServices.reloadFromFiles listeners", () => {
  test("invokes registered reload listeners with the reloaded agent ids", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const projectDir = mkdtempSync(join(tmpdir(), "lobu-reload-listener-"));
    try {
      mkdirSync(join(projectDir, "agents", "bot"), { recursive: true });
      writeFileSync(
        join(projectDir, "lobu.toml"),
        `
[agents.bot]
name = "bot"
dir = "./agents/bot"
`,
        "utf-8"
      );

      const coreServices = new CoreServices(createGatewayConfig());
      // Minimally prime reloadFromFiles: it only needs projectPath +
      // the file-loaded agents slot. It tolerates missing store/settings
      // manager — the inner `if` branches guard each step.
      (coreServices as any).projectPath = projectDir;

      const received: string[][] = [];
      coreServices.onReloadFromFiles((agentIds) => {
        received.push(agentIds);
      });

      const result = await coreServices.reloadFromFiles();

      expect(result.reloaded).toBe(true);
      expect(result.agents).toEqual(["bot"]);
      expect(received).toEqual([["bot"]]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
