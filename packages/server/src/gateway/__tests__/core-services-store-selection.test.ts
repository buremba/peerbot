import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SecretPutOptions, SecretRef } from "@lobu/core";
import type { GatewayConfig } from "../config/index.js";
import { CoreServices } from "../services/core-services.js";
import {
  type SecretListEntry,
  SecretStoreRegistry,
  type WritableSecretStore,
} from "../secrets/index.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  ensureEncryptionKey,
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { MockMessageQueue } from "./setup.js";

function createGatewayConfig(
  overrides?: Partial<GatewayConfig>
): GatewayConfig {
  return {
    agentDefaults: {},
    sessionTimeoutMinutes: 5,
    logLevel: "INFO",
    queues: {
      connectionString: "postgres://test",
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
      queues: {
        connectionString: "postgres://test",
        retryLimit: 3,
        retryDelay: 1,
        expireInSeconds: 3600,
      },
      worker: {
        startupTimeoutSeconds: 90,
        idleCleanupMinutes: 60,
        maxDeployments: 100,
      },
      cleanup: {
        initialDelayMs: 1000,
        intervalMs: 60000,
        veryOldDays: 7,
      },
    },
    mcp: {
      publicGatewayUrl: "http://localhost:8080",
    },
    auth: {},
    lobuMemory: {},
    health: {
      checkIntervalMs: 1000,
      staleThresholdMs: 2000,
      protectActiveWorkers: true,
    },
    secrets: {
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

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
});

afterEach(() => {
  delete process.env.LOBU_WORKSPACE_ROOT;
});

describe("CoreServices store selection", () => {
  test("fails fast when no host-provided stores or file-first config is present", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
    });
    (coreServices as any).queue = new MockMessageQueue();

    // After Phase 6 the Redis-backed default sub-store is gone; if the host
    // doesn't provide config/connection/access stores AND no lobu.toml is
    // present, initializeSessionServices throws.
    await expect(
      (coreServices as any).initializeSessionServices()
    ).rejects.toThrow(/No agent sub-stores configured/);
  });

  test("uses the host-provided secret store for persisted auth profiles", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const hostStore = new InMemoryWritableStore();
    const hostRegistry = new SecretStoreRegistry(hostStore, {
      host: hostStore,
    });
    const coreServices = new CoreServices(createGatewayConfig(), {
      secretStore: hostRegistry,
      stateAdapter: new InMemoryStateAdapter(),
      configStore: {
        // Minimal stub — sessionServices only checks for presence.
        getSettings: async () => null,
        saveSettings: async () => {},
        updateSettings: async () => {},
        deleteSettings: async () => {},
        hasSettings: async () => false,
        getMetadata: async () => null,
        saveMetadata: async () => {},
        updateMetadata: async () => {},
        deleteMetadata: async () => {},
        hasAgent: async () => false,
        listAgents: async () => [],
        listSandboxes: async () => [],
      } as any,
      connectionStore: {
        getConnection: async () => null,
        listConnections: async () => [],
        saveConnection: async () => {},
        updateConnection: async () => {},
        deleteConnection: async () => {},
        getChannelBinding: async () => null,
        createChannelBinding: async () => {},
        deleteChannelBinding: async () => {},
        listChannelBindings: async () => [],
        deleteAllChannelBindings: async () => 0,
      } as any,
      accessStore: {
        grant: async () => {},
        hasGrant: async () => true,
        isDenied: async () => false,
        listGrants: async () => [],
        revokeGrant: async () => {},
        addUserAgent: async () => {},
        removeUserAgent: async () => {},
        listUserAgents: async () => [],
        ownsAgent: async () => true,
      } as any,
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
