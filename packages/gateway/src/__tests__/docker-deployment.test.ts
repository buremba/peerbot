import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import fs from "node:fs";
import type {
  MessagePayload,
  OrchestratorConfig,
} from "../orchestration/base-deployment-manager";

// ---------------------------------------------------------------------------
// Mock dockerode
// ---------------------------------------------------------------------------

const mockContainer = {
  id: "container-id-123",
  start: mock(async () => {
    /* noop */
  }),
  stop: mock(async () => {
    /* noop */
  }),
  remove: mock(async () => {
    /* noop */
  }),
  inspect: mock(async () => ({ State: { Running: true } })),
  wait: mock(async () => {
    /* noop */
  }),
};

const mockVolume = {
  inspect: mock(async () => ({})),
};

const mockNetwork = {
  inspect: mock(async () => ({ Internal: true })),
  connect: mock(async () => {
    /* noop */
  }),
};

const mockDocker = {
  info: mock(async () => ({ Runtimes: {} })),
  createContainer: mock(async () => mockContainer),
  getContainer: mock(() => mockContainer),
  createVolume: mock(async () => mockVolume),
  getVolume: mock(() => mockVolume),
  createNetwork: mock(async () => mockNetwork),
  getNetwork: mock(() => mockNetwork),
  listContainers: mock(async () => []),
  getImage: mock(() => ({ inspect: mock(async () => ({})) })),
  pull: mock((_name: string, cb: Function) =>
    cb(null, {
      on: () => {
        /* noop */
      },
    })
  ),
  modem: { followProgress: (_stream: any, cb: Function) => cb(null) },
};

mock.module("dockerode", () => ({
  default: class MockDocker {
    constructor() {
      Object.assign(this, mockDocker);
    }
  },
}));

// Must import after mocks are set up
const { DockerDeploymentManager } = await import(
  "../orchestration/impl/docker-deployment"
);

// ---------------------------------------------------------------------------
// Constants & helpers
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
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
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

const MOCK_DEFAULTS: Array<
  [{ mockReset: Function; mockImplementation: Function }, Function]
> = [
  [
    mockContainer.start,
    async () => {
      /* noop */
    },
  ],
  [
    mockContainer.stop,
    async () => {
      /* noop */
    },
  ],
  [
    mockContainer.remove,
    async () => {
      /* noop */
    },
  ],
  [mockContainer.inspect, async () => ({ State: { Running: true } })],
  [mockDocker.info, async () => ({ Runtimes: {} })],
  [mockDocker.createContainer, async () => mockContainer],
  [mockDocker.getContainer, () => mockContainer],
  [mockDocker.createVolume, async () => mockVolume],
  [mockDocker.getVolume, () => mockVolume],
  [mockDocker.createNetwork, async () => mockNetwork],
  [mockDocker.getNetwork, () => mockNetwork],
  [mockDocker.listContainers, async () => []],
  [mockDocker.getImage, () => ({ inspect: mock(async () => ({})) })],
  [
    mockDocker.pull,
    (_name: string, cb: Function) =>
      cb(null, {
        on: () => {
          /* noop */
        },
      }),
  ],
  [mockVolume.inspect, async () => ({})],
  [mockNetwork.inspect, async () => ({ Internal: true })],
  [
    mockNetwork.connect,
    async () => {
      /* noop */
    },
  ],
];

function resetAllMocks() {
  for (const [mockFn, impl] of MOCK_DEFAULTS) {
    mockFn.mockReset();
    mockFn.mockImplementation(impl);
  }
}

/** Extract the main container creation options (skips init containers like alpine). */
function getMainCreateOpts(): any {
  const call = mockDocker.createContainer.mock.calls.find(
    (c: any) => c[0]?.name === "test-deploy"
  );
  return call?.[0];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DockerDeploymentManager", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    resetAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  function createManager(configOverrides?: Partial<OrchestratorConfig>) {
    const config = { ...TEST_CONFIG, ...configOverrides };
    return new DockerDeploymentManager(config);
  }

  // =========================================================================
  // ResourceParser (tested indirectly via createContainer args)
  // =========================================================================

  describe("ResourceParser (via ensureDeployment)", () => {
    test("parseMemory: 512Mi -> 512 * 1024 * 1024", async () => {
      const manager = createManager({
        worker: {
          ...TEST_CONFIG.worker,
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
        },
      });

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      const opts = mockDocker.createContainer.mock.calls[0]?.[0] as any;
      expect(opts.HostConfig.Memory).toBe(512 * 1024 * 1024);
    });

    test("parseMemory: 1Gi -> 1024 * 1024 * 1024", async () => {
      const manager = createManager({
        worker: {
          ...TEST_CONFIG.worker,
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
        },
      });

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      const opts = mockDocker.createContainer.mock.calls[0]?.[0] as any;
      expect(opts.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    });

    test("parseCpu: 500m -> 500_000_000 nanocpus", async () => {
      const manager = createManager();

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      const opts = mockDocker.createContainer.mock.calls[0]?.[0] as any;
      expect(opts.HostConfig.NanoCpus).toBe(500_000_000);
    });

    test("parseCpu: 1 core -> 1_000_000_000 nanocpus", async () => {
      const manager = createManager({
        worker: {
          ...TEST_CONFIG.worker,
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
        },
      });

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      const opts = mockDocker.createContainer.mock.calls[0]?.[0] as any;
      expect(opts.HostConfig.NanoCpus).toBe(1_000_000_000);
    });
  });

  // =========================================================================
  // Container creation & security
  // =========================================================================

  describe("ensureDeployment", () => {
    test("calls docker.createContainer with correct image", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      const opts = getMainCreateOpts();
      expect(opts).toBeDefined();
      expect(opts.Image).toBe("lobu-worker:latest");
    });

    test("drops all capabilities: CapDrop=['ALL']", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.CapDrop).toEqual(["ALL"]);
    });

    test("adds configurable capabilities via WORKER_CAPABILITIES env var", async () => {
      process.env.WORKER_CAPABILITIES = "NET_BIND_SERVICE,SYS_PTRACE";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.CapAdd).toEqual([
        "NET_BIND_SERVICE",
        "SYS_PTRACE",
      ]);
    });

    test("empty CapAdd when WORKER_CAPABILITIES not set", async () => {
      delete process.env.WORKER_CAPABILITIES;
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.CapAdd).toEqual([]);
    });

    test("enables no-new-privileges security option", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.SecurityOpt).toContain(
        "no-new-privileges:true"
      );
    });

    test("uses readonly rootfs by default", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.ReadonlyRootfs).toBe(true);
    });

    test("disables readonly rootfs when Nix packages configured", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({ nixConfig: { packages: ["nodejs"] } })
      );
      expect(getMainCreateOpts().HostConfig.ReadonlyRootfs).toBe(false);
    });

    test("disables readonly rootfs when Nix flakeUrl configured", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({
          nixConfig: { flakeUrl: "github:owner/repo" },
        })
      );
      expect(getMainCreateOpts().HostConfig.ReadonlyRootfs).toBe(false);
    });

    test("adds tmpfs for /tmp when readonly rootfs enabled", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.Tmpfs).toEqual({
        "/tmp": "rw,noexec,nosuid,size=100m",
      });
    });

    test("does not add tmpfs when Nix packages configured", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({ nixConfig: { packages: ["nodejs"] } })
      );
      expect(getMainCreateOpts().HostConfig.Tmpfs).toBeUndefined();
    });

    test("sets ShmSize to 256MB (268435456)", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.ShmSize).toBe(268435456);
    });

    test("uses gvisor runtime when available", async () => {
      mockDocker.info.mockImplementation(async () => ({
        Runtimes: { runsc: {} },
      }));
      const manager = createManager();
      await new Promise((r) => setTimeout(r, 50));

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.Runtime).toBe("runsc");
    });

    test("uses default runtime when gvisor unavailable", async () => {
      const manager = createManager();
      await new Promise((r) => setTimeout(r, 50));

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.Runtime).toBeUndefined();
    });

    test("starts container after creation", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(mockContainer.start).toHaveBeenCalled();
    });

    test("removes container if start fails", async () => {
      const removeMock = mock(async () => {
        /* noop */
      });
      mockDocker.createContainer.mockImplementation(async (opts: any) => {
        if (opts?.name === "test-deploy") {
          return {
            ...mockContainer,
            id: "failed-container",
            start: mock(async () => {
              throw new Error("start failed");
            }),
            remove: removeMock,
          };
        }
        return mockContainer;
      });

      const manager = createManager();

      await expect(
        manager.ensureDeployment(
          "test-deploy",
          "user",
          "user-id",
          createTestMessagePayload()
        )
      ).rejects.toThrow();

      expect(removeMock).toHaveBeenCalledWith({ force: true });
    });

    test("sets WorkingDir to /workspace", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().WorkingDir).toBe("/workspace");
    });
  });

  // =========================================================================
  // Docker volume management
  // =========================================================================

  describe("volume management", () => {
    test("volume created as lobu-workspace-{agentId}", async () => {
      // Make getVolume throw so ensureVolume creates a new one
      mockDocker.getVolume.mockImplementation(() => ({
        inspect: mock(async () => {
          throw new Error("no such volume");
        }),
      }));

      const manager = createManager();

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({ agentId: "my-agent" })
      );

      expect(mockDocker.createVolume).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: "lobu-workspace-my-agent",
        })
      );
    });

    test("volume shared across threads with same agentId", async () => {
      const manager = createManager();

      // First deployment
      await manager.ensureDeployment(
        "deploy-1",
        "user",
        "user-id",
        createTestMessagePayload({ agentId: "shared-agent" })
      );

      // Second deployment with same agentId
      await manager.ensureDeployment(
        "deploy-2",
        "user",
        "user-id",
        createTestMessagePayload({ agentId: "shared-agent" })
      );

      // Both main container calls should reference the same volume name
      const mainCalls = mockDocker.createContainer.mock.calls.filter(
        (call: any) =>
          call[0]?.name === "deploy-1" || call[0]?.name === "deploy-2"
      );
      expect(mainCalls.length).toBe(2);

      // In production mode (non-development), uses Mounts with volume
      for (const call of mainCalls) {
        const opts = call[0] as any;
        if (opts.HostConfig.Mounts) {
          expect(opts.HostConfig.Mounts[0].Source).toBe(
            "lobu-workspace-shared-agent"
          );
        }
      }
    });

    test("handles race condition on concurrent volume creation (409 conflict)", async () => {
      mockDocker.getVolume.mockImplementation(() => ({
        inspect: mock(async () => {
          throw new Error("no such volume");
        }),
      }));
      mockDocker.createVolume.mockImplementation(async () => {
        const err: any = new Error("already exists");
        err.statusCode = 409;
        throw err;
      });

      const manager = createManager();

      // Should not throw despite 409
      await expect(
        manager.ensureDeployment(
          "test-deploy",
          "user",
          "user-id",
          createTestMessagePayload()
        )
      ).resolves.toBeUndefined();
    });

    test("treats 409 from createContainer as benign and starts existing container if stopped", async () => {
      const existing = {
        inspect: mock(async () => ({ State: { Running: false } })),
        start: mock(async () => {
          /* noop */
        }),
      };
      mockDocker.createContainer.mockImplementationOnce(async () => {
        const err: any = new Error(
          'Conflict. The container name "/test-deploy" is already in use'
        );
        err.statusCode = 409;
        throw err;
      });
      mockDocker.getContainer.mockImplementationOnce(() => existing as any);

      const manager = createManager();

      await expect(
        manager.ensureDeployment(
          "test-deploy",
          "user",
          "user-id",
          createTestMessagePayload()
        )
      ).resolves.toBeUndefined();

      expect(existing.inspect).toHaveBeenCalled();
      expect(existing.start).toHaveBeenCalled();
    });

    test("treats 409 from createContainer as benign and skips start if already running", async () => {
      const existing = {
        inspect: mock(async () => ({ State: { Running: true } })),
        start: mock(async () => {
          /* noop */
        }),
      };
      mockDocker.createContainer.mockImplementationOnce(async () => {
        const err: any = new Error("already in use");
        err.statusCode = 409;
        throw err;
      });
      mockDocker.getContainer.mockImplementationOnce(() => existing as any);

      const manager = createManager();

      await expect(
        manager.ensureDeployment(
          "test-deploy",
          "user",
          "user-id",
          createTestMessagePayload()
        )
      ).resolves.toBeUndefined();

      expect(existing.start).not.toHaveBeenCalled();
    });

    test("development mode uses bind mounts", async () => {
      process.env.NODE_ENV = "development";
      process.env.DEPLOYMENT_MODE = "docker";
      process.env.LOBU_DEV_PROJECT_PATH = "/app";

      const manager = createManager();

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({ agentId: "dev-agent" })
      );

      const mainCall = mockDocker.createContainer.mock.calls.find(
        (call: any) => call[0]?.name === "test-deploy"
      );
      const opts = mainCall![0] as any;
      expect(opts.HostConfig.Binds).toBeDefined();
      expect(opts.HostConfig.Binds[0]).toContain(
        "/app/workspaces/dev-agent:/workspace"
      );
    });
  });

  // =========================================================================
  // Docker network
  // =========================================================================

  describe("network management", () => {
    test("internal network created/checked with Internal flag", async () => {
      // The constructor calls ensureInternalNetwork
      delete process.env.WORKER_NETWORK;
      mockNetwork.inspect.mockImplementation(async () => ({ Internal: true }));

      createManager();
      // ensureInternalNetwork is fire-and-forget, give it time
      await new Promise((r) => setTimeout(r, 50));

      expect(mockDocker.getNetwork).toHaveBeenCalled();
    });

    test("WORKER_NETWORK env var overrides network name", async () => {
      process.env.WORKER_NETWORK = "custom-network";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.NetworkMode).toBe("custom-network");
    });

    test("uses compose project name for default network", async () => {
      delete process.env.WORKER_NETWORK;
      process.env.COMPOSE_PROJECT_NAME = "myproject";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.NetworkMode).toBe(
        "myproject_lobu-internal"
      );
    });

    test("host mode connects to public network too", async () => {
      delete process.env.WORKER_NETWORK;
      // Simulate running on host (not in container)
      delete process.env.CONTAINER;
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

      const manager = createManager();
      await new Promise((r) => setTimeout(r, 50));

      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );

      // Should attempt to connect to public network
      expect(mockNetwork.connect).toHaveBeenCalled();

      existsSpy.mockRestore();
    });
  });

  // =========================================================================
  // Dispatcher host
  // =========================================================================

  describe("dispatcher host", () => {
    function getDispatcherUrlEnv() {
      return (getMainCreateOpts().Env as string[]).find((e: string) =>
        e.startsWith("DISPATCHER_URL=")
      );
    }

    test('returns "gateway" when running in container (/.dockerenv exists)', async () => {
      const existsSpy = spyOn(fs, "existsSync").mockImplementation(
        (p: any) => String(p) === "/.dockerenv"
      );
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getDispatcherUrlEnv()).toContain("gateway");
      existsSpy.mockRestore();
    });

    test('returns "gateway" when CONTAINER=true', async () => {
      process.env.CONTAINER = "true";
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getDispatcherUrlEnv()).toContain("gateway");
      existsSpy.mockRestore();
    });

    test('returns "host.docker.internal" when running on host', async () => {
      delete process.env.CONTAINER;
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getDispatcherUrlEnv()).toContain("host.docker.internal");
      existsSpy.mockRestore();
    });
  });

  // =========================================================================
  // Docker image reference
  // =========================================================================

  describe("image reference", () => {
    test("uses digest reference when configured: repo@sha256:abc123", async () => {
      const manager = createManager({
        worker: {
          ...TEST_CONFIG.worker,
          image: {
            repository: "lobu-worker",
            tag: "latest",
            digest: "abc123def456",
            pullPolicy: "IfNotPresent",
          },
        },
      });
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().Image).toBe("lobu-worker@sha256:abc123def456");
    });

    test("uses tag reference when no digest: repo:tag", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().Image).toBe("lobu-worker:latest");
    });

    test("handles digest that already has sha256: prefix", async () => {
      const manager = createManager({
        worker: {
          ...TEST_CONFIG.worker,
          image: {
            repository: "lobu-worker",
            tag: "latest",
            digest: "sha256:abc123def456",
            pullPolicy: "IfNotPresent",
          },
        },
      });
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().Image).toBe("lobu-worker@sha256:abc123def456");
    });
  });

  // =========================================================================
  // deleteDeployment
  // =========================================================================

  describe("deleteDeployment", () => {
    test("calls stop + remove on container", async () => {
      const manager = createManager();

      await manager.deleteDeployment("test-deploy");

      expect(mockContainer.stop).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalled();
    });

    test("handles 404 (container already deleted) gracefully", async () => {
      const stopMock = mock(async () => {
        /* noop */
      });
      const removeMock = mock(async () => {
        const err: any = new Error("not found");
        err.statusCode = 404;
        throw err;
      });
      mockDocker.getContainer.mockImplementation(() => ({
        stop: stopMock,
        remove: removeMock,
      }));

      const manager = createManager();

      // Should not throw on 404
      await expect(
        manager.deleteDeployment("nonexistent")
      ).resolves.toBeUndefined();
    });

    test("handles already-stopped container gracefully", async () => {
      mockContainer.stop.mockImplementation(async () => {
        throw new Error("container already stopped");
      });

      const manager = createManager();

      // Should not throw - stop failure is caught
      await expect(
        manager.deleteDeployment("test-deploy")
      ).resolves.toBeUndefined();
      expect(mockContainer.remove).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // scaleDeployment
  // =========================================================================

  describe("scaleDeployment", () => {
    test("scaleDeployment(0) stops running container", async () => {
      mockContainer.inspect.mockImplementation(async () => ({
        State: { Running: true },
      }));

      const manager = createManager();
      await manager.scaleDeployment("test-deploy", 0);

      expect(mockContainer.stop).toHaveBeenCalled();
    });

    test("scaleDeployment(1) starts stopped container", async () => {
      mockContainer.inspect.mockImplementation(async () => ({
        State: { Running: false },
      }));

      const manager = createManager();
      await manager.scaleDeployment("test-deploy", 1);

      expect(mockContainer.start).toHaveBeenCalled();
    });

    test("scaleDeployment(0) is a no-op if container already stopped", async () => {
      mockContainer.inspect.mockImplementation(async () => ({
        State: { Running: false },
      }));

      const manager = createManager();
      await manager.scaleDeployment("test-deploy", 0);

      expect(mockContainer.stop).not.toHaveBeenCalled();
    });

    test("scaleDeployment(1) is a no-op if container already running", async () => {
      mockContainer.inspect.mockImplementation(async () => ({
        State: { Running: true },
      }));

      const manager = createManager();
      await manager.scaleDeployment("test-deploy", 1);

      expect(mockContainer.start).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // listDeployments
  // =========================================================================

  describe("listDeployments", () => {
    test("with no containers returns empty", async () => {
      mockDocker.listContainers.mockImplementation(async () => []);

      const manager = createManager();
      const result = await manager.listDeployments();

      expect(result).toEqual([]);
    });

    test("with containers returns DeploymentInfo entries", async () => {
      const now = Math.floor(Date.now() / 1000);
      mockDocker.listContainers.mockImplementation(async () => [
        {
          Names: ["/lobu-worker-test-123"],
          State: "running",
          Created: now - 60, // 60 seconds ago
          Labels: {
            "app.kubernetes.io/component": "worker",
            "lobu.io/created": new Date((now - 60) * 1000).toISOString(),
          },
        },
        {
          Names: ["/lobu-worker-test-456"],
          State: "exited",
          Created: now - 3600, // 1 hour ago
          Labels: {
            "app.kubernetes.io/component": "worker",
          },
        },
      ]);

      const manager = createManager();
      const result = await manager.listDeployments();

      expect(result).toHaveLength(2);
      expect(result[0].deploymentName).toBe("lobu-worker-test-123");
      expect(result[0].replicas).toBe(1); // running
      expect(result[1].deploymentName).toBe("lobu-worker-test-456");
      expect(result[1].replicas).toBe(0); // exited
    });

    test("filters by worker label", async () => {
      const manager = createManager();
      await manager.listDeployments();

      expect(mockDocker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ["app.kubernetes.io/component=worker"],
        },
      });
    });
  });

  // =========================================================================
  // Activity tracking
  // =========================================================================

  describe("activity tracking", () => {
    test("updateDeploymentActivity stores timestamp", async () => {
      const manager = createManager();

      await manager.updateDeploymentActivity("test-deploy");

      // Verify by listing deployments with a container matching the name
      const now = Math.floor(Date.now() / 1000);
      mockDocker.listContainers.mockImplementation(async () => [
        {
          Names: ["/test-deploy"],
          State: "running",
          Created: now - 86400, // 1 day ago
          Labels: {
            "app.kubernetes.io/component": "worker",
            "lobu.io/created": new Date((now - 86400) * 1000).toISOString(),
          },
        },
      ]);

      const deployments = await manager.listDeployments();
      // The tracked activity should be very recent (just now), not 1 day ago
      expect(deployments[0].minutesIdle).toBeLessThan(1);
    });

    test("listDeployments uses most recent of tracked vs label activity", async () => {
      const manager = createManager();
      const now = Math.floor(Date.now() / 1000);

      // Set up a container with an old label timestamp
      mockDocker.listContainers.mockImplementation(async () => [
        {
          Names: ["/tracked-deploy"],
          State: "running",
          Created: now - 7200, // 2 hours ago
          Labels: {
            "app.kubernetes.io/component": "worker",
            "lobu.io/last-activity": new Date(
              (now - 7200) * 1000
            ).toISOString(),
          },
        },
      ]);

      // Update activity in-memory (very recent)
      await manager.updateDeploymentActivity("tracked-deploy");

      const deployments = await manager.listDeployments();
      // Should use tracked (recent) not label (2 hours ago)
      expect(deployments[0].minutesIdle).toBeLessThan(1);
    });
  });

  // =========================================================================
  // validateWorkerImage
  // =========================================================================

  describe("validateWorkerImage", () => {
    test("succeeds when image exists locally", async () => {
      const manager = createManager();
      await expect(manager.validateWorkerImage()).resolves.toBeUndefined();
    });

    test("pulls image when not found locally", async () => {
      mockDocker.getImage.mockImplementation(() => ({
        inspect: mock(async () => {
          throw new Error("No such image");
        }),
      }));

      const manager = createManager();
      await expect(manager.validateWorkerImage()).resolves.toBeUndefined();
      expect(mockDocker.pull).toHaveBeenCalled();
    });

    test("throws when image not found and pull fails", async () => {
      mockDocker.getImage.mockImplementation(() => ({
        inspect: mock(async () => {
          throw new Error("No such image");
        }),
      }));
      mockDocker.pull.mockImplementation((_name: string, cb: Function) =>
        cb(new Error("pull failed"))
      );

      const manager = createManager();
      await expect(manager.validateWorkerImage()).rejects.toThrow(
        "does not exist locally and pull failed"
      );
    });
  });

  // =========================================================================
  // Labels & compose integration
  // =========================================================================

  describe("labels", () => {
    test("sets base worker labels", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      const labels = getMainCreateOpts().Labels;
      expect(labels["app.kubernetes.io/name"]).toBe("lobu");
      expect(labels["app.kubernetes.io/component"]).toBe("worker");
      expect(labels["lobu/managed-by"]).toBe("orchestrator");
    });

    test("sets Docker Compose project labels", async () => {
      process.env.COMPOSE_PROJECT_NAME = "myproject";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      const labels = getMainCreateOpts().Labels;
      expect(labels["com.docker.compose.project"]).toBe("myproject");
      expect(labels["com.docker.compose.service"]).toBe("test-deploy");
    });

    test("sets agent-id label", async () => {
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload({ agentId: "my-agent-123" })
      );
      expect(getMainCreateOpts().Labels["lobu.io/agent-id"]).toBe(
        "my-agent-123"
      );
    });
  });

  // =========================================================================
  // Extra hosts & host mode
  // =========================================================================

  describe("extra hosts", () => {
    test("adds ExtraHosts when running on host (not in container)", async () => {
      delete process.env.CONTAINER;
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.ExtraHosts).toEqual([
        "host.docker.internal:host-gateway",
      ]);
      existsSpy.mockRestore();
    });

    test("does not add ExtraHosts when running in container", async () => {
      process.env.CONTAINER = "true";
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.ExtraHosts).toBeUndefined();
      existsSpy.mockRestore();
    });
  });

  // =========================================================================
  // Security options
  // =========================================================================

  describe("advanced security options", () => {
    test("adds seccomp profile when WORKER_SECCOMP_PROFILE set", async () => {
      process.env.WORKER_SECCOMP_PROFILE = "/path/to/seccomp.json";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.SecurityOpt).toContain(
        "seccomp=/path/to/seccomp.json"
      );
    });

    test("adds apparmor profile when WORKER_APPARMOR_PROFILE set", async () => {
      process.env.WORKER_APPARMOR_PROFILE = "docker-custom";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      expect(getMainCreateOpts().HostConfig.SecurityOpt).toContain(
        "apparmor=docker-custom"
      );
    });

    test("disables readonly rootfs when WORKER_READONLY_ROOTFS=false", async () => {
      process.env.WORKER_READONLY_ROOTFS = "false";
      const manager = createManager();
      await manager.ensureDeployment(
        "test-deploy",
        "user",
        "user-id",
        createTestMessagePayload()
      );
      const hc = getMainCreateOpts().HostConfig;
      expect(hc.ReadonlyRootfs).toBe(false);
      expect(hc.Tmpfs).toBeUndefined();
    });
  });
});
