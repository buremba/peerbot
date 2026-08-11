import { describe, expect, test } from "bun:test";
import type { Daytona } from "@daytona/sdk";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOwlettoInManifest,
  assertReusableSandbox,
  canReusePreview,
  checkoutCleanupCommand,
  daytonaConfigPath,
  defaultSandboxName,
  deleteSessionIfPresent,
  dependencyInstallCondition,
  embeddedPostgresStopCommand,
  lifecycleIntervals,
  managedDevProcessStopCommand,
  orchestrateRemoteDevelopment,
  pinnedBunEnvironment,
  readOptionalRemoteFile,
  readSessionLogs,
  resolveCliProfile,
  sanitizeSandboxName,
  shellQuote,
  snapshotUsesVm,
  suspendSandbox,
  up,
} from "../dev-remote";

describe("dev-remote helpers", () => {
  test("builds a stable, safe sandbox name", () => {
    expect(sanitizeSandboxName("Burak Emre!@Mac")).toBe("burak-emre-mac");
    expect(sanitizeSandboxName("---")).toBe("developer");
    expect(defaultSandboxName("Burak Emre")).toBe("lobu-dev-burak-emre");
  });

  test("uses snapshot metadata for VM and container lifecycles", async () => {
    const classes = new Map([
      ["custom-workstation", "linux-vm"],
      ["custom-toolbox", "container"],
    ]);
    const daytona = {
      snapshot: {
        get: async (name: string) => ({ sandboxClass: classes.get(name) }),
      },
    };
    const vm = await snapshotUsesVm(daytona, "custom-workstation");
    const container = await snapshotUsesVm(daytona, "custom-toolbox");
    expect(vm).toBe(true);
    expect(container).toBe(false);
    await expect(snapshotUsesVm(daytona, "unknown-snapshot")).rejects.toThrow(
      "unsupported sandbox class missing"
    );
    expect(lifecycleIntervals(vm, 15)).toEqual({
      autoStopInterval: 0,
      autoPauseInterval: 15,
    });
    expect(lifecycleIntervals(container, 15)).toEqual({ autoStopInterval: 15 });

    let pauseCalls = 0;
    let stopCalls = 0;
    const autoDeleteIntervals: number[] = [];
    const lifecycleSandbox = {
      labels: { app: "lobu", purpose: "remote-development" },
      name: "lobu-dev-test",
      pause: async () => {
        pauseCalls += 1;
      },
      public: false,
      setAutoDeleteInterval: async (interval: number) => {
        autoDeleteIntervals.push(interval);
      },
      state: "started" as const,
      stop: async () => {
        stopCalls += 1;
      },
    };
    await suspendSandbox(lifecycleSandbox, vm);
    await suspendSandbox(lifecycleSandbox, container);
    expect(pauseCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(autoDeleteIntervals).toEqual([-1, -1]);
  });

  test("resolves platform-specific CLI config paths", () => {
    expect(daytonaConfigPath("/Users/test", "darwin", "", "")).toBe(
      "/Users/test/Library/Application Support/daytona/config.json"
    );
    expect(daytonaConfigPath("/home/test", "linux", "", "")).toBe(
      "/home/test/.config/daytona/config.json"
    );
    expect(
      daytonaConfigPath("/home/test", "linux", "/custom/daytona", "")
    ).toBe("/custom/daytona/config.json");
    expect(daytonaConfigPath("/home/test", "linux", "", "/xdg")).toBe(
      "/xdg/daytona/config.json"
    );
  });

  test("uses the active CLI JWT profile without exposing refresh credentials", () => {
    expect(
      resolveCliProfile({
        activeProfile: "initial",
        profiles: [
          {
            id: "initial",
            activeOrganizationId: "org-id",
            api: {
              url: "https://example.test/api",
              token: { accessToken: "jwt" },
            },
          },
        ],
      })
    ).toEqual({
      jwtToken: "jwt",
      organizationId: "org-id",
      apiUrl: "https://example.test/api",
    });
  });

  test("rejects an incomplete CLI profile", () => {
    expect(() =>
      resolveCliProfile({ activeProfile: "missing", profiles: [] })
    ).toThrow("no active profile");
    expect(() =>
      resolveCliProfile({
        activeProfile: "initial",
        profiles: [{ id: "initial" }],
      })
    ).toThrow("login is incomplete");
  });

  test("quotes shell metacharacters as data", () => {
    expect(shellQuote("hello $(touch /tmp/nope) ' world")).toBe(
      "'hello $(touch /tmp/nope) '\"'\"' world'"
    );
  });

  test("pins the requested Bun ahead of a conflicting base PATH", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lobu-bun-path-"));
    try {
      const pinnedBin = join(tempRoot, "pinned");
      const conflictingBin = join(tempRoot, "conflicting");
      mkdirSync(pinnedBin);
      mkdirSync(conflictingBin);
      const pinnedBun = join(pinnedBin, "bun");
      const conflictingBun = join(conflictingBin, "bun");
      writeFileSync(pinnedBun, "#!/bin/sh\necho 1.3.5\n");
      writeFileSync(conflictingBun, "#!/bin/sh\necho 9.9.9\n");
      chmodSync(pinnedBun, 0o755);
      chmodSync(conflictingBun, 0o755);

      const result = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          [...pinnedBunEnvironment("1.3.5", pinnedBin), "command -v bun"].join(
            "\n"
          ),
        ],
        { env: { ...process.env, PATH: conflictingBin } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(pinnedBun);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("only reuses signed previews with more than a minute remaining", () => {
    expect(
      canReusePreview({ url: "https://preview.test", expiresAt: 200 }, 100)
    ).toBe(true);
    expect(
      canReusePreview({ url: "https://preview.test", expiresAt: 150 }, 100)
    ).toBe(false);
    expect(canReusePreview(undefined, 100)).toBe(false);
  });

  test("replaces directories with files or symlinks while preserving dependencies", () => {
    expect(checkoutCleanupCommand("/home/daytona/lobu")).toBe(
      "find '/home/daytona/lobu' -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +"
    );

    const tempRoot = mkdtempSync(join(tmpdir(), "lobu-checkout-transition-"));
    try {
      const remoteRoot = join(tempRoot, "remote");
      const stagedRoot = join(tempRoot, "staged");
      const archive = join(tempRoot, "source.tar.gz");
      mkdirSync(join(remoteRoot, "node_modules"), { recursive: true });
      writeFileSync(join(remoteRoot, "node_modules", "sentinel"), "cached");
      mkdirSync(join(remoteRoot, "packages", "feature"), { recursive: true });
      writeFileSync(join(remoteRoot, "packages", "feature", "old.ts"), "old");
      mkdirSync(join(remoteRoot, "scripts", "connector"), { recursive: true });
      writeFileSync(join(remoteRoot, "scripts", "connector", "old.ts"), "old");

      mkdirSync(join(stagedRoot, "packages"), { recursive: true });
      writeFileSync(join(stagedRoot, "packages", "feature"), "replacement");
      mkdirSync(join(stagedRoot, "scripts"), { recursive: true });
      writeFileSync(join(stagedRoot, "target.txt"), "target");
      symlinkSync("../target.txt", join(stagedRoot, "scripts", "connector"));
      const archiveResult = Bun.spawnSync([
        "tar",
        "-czf",
        archive,
        "-C",
        stagedRoot,
        ".",
      ]);
      expect(archiveResult.exitCode).toBe(0);

      const replaceResult = Bun.spawnSync([
        "/bin/sh",
        "-c",
        `${checkoutCleanupCommand(remoteRoot)}\ntar -xzf ${shellQuote(archive)} -C ${shellQuote(remoteRoot)}`,
      ]);
      expect(replaceResult.exitCode).toBe(0);
      expect(
        readFileSync(join(remoteRoot, "packages", "feature"), "utf8")
      ).toBe("replacement");
      expect(
        lstatSync(join(remoteRoot, "scripts", "connector")).isSymbolicLink()
      ).toBe(true);
      expect(
        readFileSync(join(remoteRoot, "node_modules", "sentinel"), "utf8")
      ).toBe("cached");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("reinstalls workspace dependencies after a source refresh", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lobu-install-marker-"));
    try {
      const checkout = join(tempRoot, "checkout");
      const stateRoot = join(tempRoot, "state");
      mkdirSync(join(checkout, "node_modules"), { recursive: true });
      mkdirSync(stateRoot);
      writeFileSync(join(stateRoot, "bun-lock-sha"), "lock-current\n");
      writeFileSync(join(stateRoot, "install-source-sha"), "source-old\n");
      const command = `if ${dependencyInstallCondition("lock-current", "source-new", stateRoot)}; then printf install; fi`;
      const staleResult = Bun.spawnSync(["/bin/sh", "-c", command], {
        cwd: checkout,
      });
      expect(staleResult.exitCode).toBe(0);
      expect(staleResult.stdout.toString()).toBe("install");

      writeFileSync(join(stateRoot, "install-source-sha"), "source-new\n");
      const currentResult = Bun.spawnSync(["/bin/sh", "-c", command], {
        cwd: checkout,
      });
      expect(currentResult.exitCode).toBe(0);
      expect(currentResult.stdout.toString()).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("stops only the embedded Postgres process recorded by its data directory", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lobu-postgres-stop-"));
    const child = Bun.spawn(["sleep", "60"]);
    try {
      const checkoutRoot = join(tempRoot, "checkout");
      const dataRoot = join(tempRoot, "data");
      const pgData = join(dataRoot, ".lobu", "pgdata");
      const procRoot = join(tempRoot, "proc");
      const pgCtl = join(
        checkoutRoot,
        "node_modules",
        "@embedded-postgres",
        "test",
        "native",
        "bin",
        "pg_ctl"
      );
      const record = join(tempRoot, "pg-ctl-args");
      mkdirSync(pgData, { recursive: true });
      mkdirSync(join(procRoot, String(child.pid)), { recursive: true });
      mkdirSync(join(pgCtl, ".."), { recursive: true });
      writeFileSync(
        join(pgData, "postmaster.pid"),
        `${child.pid}\n${pgData}\n`
      );
      symlinkSync(
        join(tempRoot, "postgres"),
        join(procRoot, String(child.pid), "exe")
      );
      writeFileSync(
        pgCtl,
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$PG_CTL_RECORD"\nrm -f "$3/postmaster.pid"\n'
      );
      chmodSync(pgCtl, 0o755);

      const result = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          embeddedPostgresStopCommand(dataRoot, checkoutRoot, procRoot),
        ],
        { env: { ...process.env, PG_CTL_RECORD: record } }
      );
      expect(result.exitCode).toBe(0);
      expect(readFileSync(record, "utf8").trim()).toBe(
        `stop -D ${pgData} -m fast -w -t 30`
      );

      writeFileSync(
        join(pgData, "postmaster.pid"),
        `${child.pid}\n${pgData}\n`
      );
      rmSync(join(procRoot, String(child.pid), "exe"));
      symlinkSync(
        join(tempRoot, "unrelated-process"),
        join(procRoot, String(child.pid), "exe")
      );
      rmSync(record);
      const refused = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          embeddedPostgresStopCommand(dataRoot, checkoutRoot, procRoot),
        ],
        { env: { ...process.env, PG_CTL_RECORD: record } }
      );
      expect(refused.exitCode).not.toBe(0);
      expect(() => readFileSync(record, "utf8")).toThrow();
      expect(readFileSync(join(pgData, "postmaster.pid"), "utf8")).toBe(
        `${child.pid}\n${pgData}\n`
      );
    } finally {
      child.kill();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("stops only the managed Lobu process group", () => {
    const command = managedDevProcessStopCommand(
      "/remote/state",
      "/remote/checkout",
      "/remote/proc"
    );
    expect(command).toContain("dev-process-group");
    expect(command).toContain('kill -INT -- "-$pid"');
    expect(command).toContain("actual_cwd=$(readlink");
    expect(command).toContain("actual_pgid=$(ps -o pgid=");
    expect(command).toContain("expected_cwd='/remote/checkout'");
    expect(command).toContain("grep -a -F -q bun");
  });

  test("initializes Owletto before the remote development target", () => {
    const makefile = readFileSync(
      join(import.meta.dir, "../..", "Makefile"),
      "utf8"
    );
    expect(makefile).toMatch(/^dev-remote: ensure-submodule$/m);
  });

  test("fails closed when source enumeration omits Owletto", () => {
    expect(() =>
      assertOwlettoInManifest("Makefile\0packages/owletto/src/main.ts\0")
    ).not.toThrow();
    expect(() =>
      assertOwlettoInManifest("Makefile\0scripts/dev-remote.ts\0")
    ).toThrow("Owletto is not initialized");
  });

  test("reuses a healthy same-source remote without restarting", async () => {
    const calls: string[] = [];
    const result = await orchestrateRemoteDevelopment({
      remoteSource: "same",
      sourceId: "same",
      storedPreview: {
        url: "https://existing.test",
        expiresAt: Date.now() / 1000 + 3600,
      },
      isHealthy: async () => {
        calls.push("healthy");
        return true;
      },
      sync: async () => {
        calls.push("sync");
      },
      prepare: async () => {
        calls.push("prepare");
      },
      record: async () => {
        calls.push("record");
      },
      createPreview: async () => {
        calls.push("preview");
        return { url: "https://new.test", expiresAt: Date.now() / 1000 + 60 };
      },
      persistPreview: async () => {
        calls.push("persist-preview");
      },
      start: async () => {
        calls.push("start");
      },
      waitUntilHealthy: async () => {
        calls.push("ready");
      },
    });
    expect(result).toBe("https://existing.test");
    expect(calls).toEqual(["healthy"]);
  });

  test("restarts an unhealthy same-source remote with its valid preview", async () => {
    const calls: string[] = [];
    let remoteBun = "1.3.4";
    const result = await orchestrateRemoteDevelopment({
      remoteSource: "same",
      sourceId: "same",
      storedPreview: {
        url: "https://existing.test",
        expiresAt: Date.now() / 1000 + 3600,
      },
      isHealthy: async () => {
        calls.push("healthy");
        return false;
      },
      sync: async () => {
        calls.push("sync");
      },
      prepare: async () => {
        calls.push("prepare");
        remoteBun = "1.3.5";
      },
      record: async () => {
        calls.push("record");
      },
      createPreview: async () => {
        calls.push("preview");
        return { url: "https://new.test", expiresAt: Date.now() / 1000 + 60 };
      },
      persistPreview: async () => {
        calls.push("persist-preview");
      },
      start: async (url) => {
        if (remoteBun !== "1.3.5") throw new Error("stale Bun runtime");
        calls.push(`start:${url}`);
      },
      waitUntilHealthy: async () => {
        calls.push("ready");
      },
    });
    expect(result).toBe("https://existing.test");
    expect(calls).toEqual([
      "healthy",
      "prepare",
      "start:https://existing.test",
      "ready",
    ]);
  });

  test("syncs, prepares, records, rotates preview, and starts in order", async () => {
    const calls: string[] = [];
    const result = await orchestrateRemoteDevelopment({
      remoteSource: "old",
      sourceId: "new",
      storedPreview: { url: "https://expired.test", expiresAt: 0 },
      isHealthy: async () => {
        calls.push("healthy");
        return true;
      },
      sync: async () => {
        calls.push("sync");
      },
      prepare: async () => {
        calls.push("prepare");
      },
      record: async () => {
        calls.push("record");
      },
      createPreview: async () => {
        calls.push("preview");
        return { url: "https://new.test", expiresAt: Date.now() / 1000 + 60 };
      },
      persistPreview: async () => {
        calls.push("persist-preview");
      },
      start: async (url) => {
        calls.push(`start:${url}`);
      },
      waitUntilHealthy: async () => {
        calls.push("ready");
      },
    });
    expect(result).toBe("https://new.test");
    expect(calls).toEqual([
      "sync",
      "prepare",
      "record",
      "preview",
      "start:https://new.test",
      "ready",
      "persist-preview",
    ]);
  });

  test("does not persist a rotated preview until a retry starts successfully", async () => {
    const persisted: string[] = [];
    let attempts = 0;
    const run = () =>
      orchestrateRemoteDevelopment({
        remoteSource: "same",
        sourceId: "same",
        storedPreview: undefined,
        isHealthy: async () => false,
        sync: async () => undefined,
        prepare: async () => undefined,
        record: async () => undefined,
        createPreview: async () => ({
          url: `https://preview-${attempts + 1}.test`,
          expiresAt: Date.now() / 1000 + 3600,
        }),
        persistPreview: async (preview) => {
          persisted.push(preview.url);
        },
        start: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("start failed");
        },
        waitUntilHealthy: async () => undefined,
      });

    await expect(run()).rejects.toThrow("start failed");
    expect(persisted).toEqual([]);
    await expect(run()).resolves.toBe("https://preview-2.test");
    expect(persisted).toEqual(["https://preview-2.test"]);
  });

  test("does not record or start when preparation fails", async () => {
    const calls: string[] = [];
    await expect(
      orchestrateRemoteDevelopment({
        remoteSource: "old",
        sourceId: "new",
        storedPreview: undefined,
        isHealthy: async () => true,
        sync: async () => {
          calls.push("sync");
        },
        prepare: async () => {
          calls.push("prepare");
          throw new Error("install failed");
        },
        record: async () => {
          calls.push("record");
        },
        createPreview: async () => ({
          url: "https://new.test",
          expiresAt: Date.now() / 1000 + 60,
        }),
        persistPreview: async () => undefined,
        start: async () => {
          calls.push("start");
        },
        waitUntilHealthy: async () => {
          calls.push("ready");
        },
      })
    ).rejects.toThrow("install failed");
    expect(calls).toEqual(["sync", "prepare"]);
  });

  test("drives private SDK creation through sync, prepare, preview, and health", async () => {
    const calls: string[] = [];
    let createdParams: Record<string, unknown> | undefined;
    const processApi = {
      executeCommand: async (command: string) => {
        if (command.startsWith("if [ ! -e ")) {
          calls.push(
            command.includes("preview.json") ? "read-preview" : "read-source"
          );
          return { exitCode: 44, result: "" };
        }
        if (command.includes("bun install --frozen-lockfile"))
          calls.push("prepare");
        if (command.includes("/source-sha")) calls.push("record");
        if (command.includes("curl --fail --silent")) calls.push("health");
        if (command.includes("preview.next.json"))
          calls.push("persist-preview");
        return { exitCode: 0, result: "" };
      },
      deleteSession: async () => {
        calls.push("delete-session");
      },
      createSession: async () => {
        calls.push("create-session");
      },
      executeSessionCommand: async () => {
        calls.push("start-session");
      },
    };
    const sandbox = {
      name: "lobu-dev-sdk-test",
      labels: { app: "lobu", purpose: "remote-development" },
      public: false,
      snapshot: "custom-container",
      state: "stopped",
      start: async () => {
        calls.push("start-sandbox");
        sandbox.state = "started";
      },
      refreshData: async () => {
        calls.push("refresh");
      },
      setAutostopInterval: async (interval: number) => {
        calls.push(`auto-stop:${interval}`);
      },
      setTtl: async (interval: number) => {
        calls.push(`ttl:${interval}`);
      },
      setAutoDeleteInterval: async (interval: number) => {
        calls.push(`auto-delete:${interval}`);
      },
      fs: {
        uploadFile: async () => {
          calls.push("upload");
        },
      },
      process: processApi,
      getSignedPreviewUrl: async () => {
        calls.push("preview");
        return { url: "https://preview.test" };
      },
    };
    const daytona = {
      list: () => ({
        [Symbol.asyncIterator]() {
          calls.push("list");
          return {
            next: async () => ({ done: true as const, value: undefined }),
          };
        },
      }),
      snapshot: {
        get: async () => ({ sandboxClass: "container" }),
      },
      create: async (params: Record<string, unknown>) => {
        calls.push("create");
        createdParams = params;
        return sandbox;
      },
    } as unknown as Daytona;

    const previousName = process.env.DAYTONA_DEV_NAME;
    const previousSnapshot = process.env.DAYTONA_DEV_SNAPSHOT;
    process.env.DAYTONA_DEV_NAME = "lobu-dev-sdk-test";
    process.env.DAYTONA_DEV_SNAPSHOT = "custom-container";
    try {
      await up(daytona, {
        assertCleanTree: () => {
          calls.push("clean");
        },
        sourceIdentity: () => "source-new",
      });
    } finally {
      if (previousName === undefined) delete process.env.DAYTONA_DEV_NAME;
      else process.env.DAYTONA_DEV_NAME = previousName;
      if (previousSnapshot === undefined)
        delete process.env.DAYTONA_DEV_SNAPSHOT;
      else process.env.DAYTONA_DEV_SNAPSHOT = previousSnapshot;
    }

    expect(createdParams).toMatchObject({
      name: "lobu-dev-sdk-test",
      snapshot: "custom-container",
      labels: { app: "lobu", purpose: "remote-development" },
      public: false,
      autoStopInterval: 15,
      autoDeleteInterval: -1,
      ttlMinutes: 0,
    });
    expect(calls.filter((call) => call === "upload")).toHaveLength(1);
    expect(calls).toContain("auto-delete:-1");
    const ordered = [
      "upload",
      "prepare",
      "record",
      "preview",
      "start-session",
      "health",
      "persist-preview",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(calls.indexOf(ordered[index - 1] ?? "")).toBeLessThan(
        calls.indexOf(ordered[index] ?? "")
      );
    }
  });

  test("reuses an existing healthy private sandbox through the SDK path", async () => {
    const calls: string[] = [];
    const preview = JSON.stringify({
      url: "https://existing.test",
      expiresAt: Date.now() / 1000 + 3600,
    });
    const sandbox = {
      name: "lobu-dev-sdk-test",
      labels: { app: "lobu", purpose: "remote-development" },
      public: false,
      snapshot: "custom-container",
      state: "started",
      refreshData: async () => {
        calls.push("refresh");
      },
      setAutostopInterval: async () => {
        calls.push("auto-stop");
      },
      setTtl: async () => {
        calls.push("ttl");
      },
      setAutoDeleteInterval: async (interval: number) => {
        calls.push(`auto-delete:${interval}`);
      },
      fs: {
        uploadFile: async () => {
          calls.push("unexpected-upload");
        },
      },
      process: {
        executeCommand: async (command: string) => {
          if (command.includes("/source-sha"))
            return { exitCode: 0, result: "source-same" };
          if (command.includes("/preview.json"))
            return { exitCode: 0, result: preview };
          if (command.includes("curl --fail --silent")) calls.push("health");
          return { exitCode: 0, result: "" };
        },
      },
      getSignedPreviewUrl: async () => {
        calls.push("unexpected-preview");
        return { url: "https://new.test" };
      },
    };
    const daytona = {
      async *list() {
        calls.push("list");
        yield sandbox;
      },
      snapshot: {
        get: async () => ({ sandboxClass: "container" }),
      },
      create: async () => {
        calls.push("unexpected-create");
        return sandbox;
      },
    } as unknown as Daytona;

    const previousName = process.env.DAYTONA_DEV_NAME;
    process.env.DAYTONA_DEV_NAME = "lobu-dev-sdk-test";
    try {
      await up(daytona, {
        assertCleanTree: () => {
          calls.push("clean");
        },
        sourceIdentity: () => "source-same",
      });
    } finally {
      if (previousName === undefined) delete process.env.DAYTONA_DEV_NAME;
      else process.env.DAYTONA_DEV_NAME = previousName;
    }
    expect(calls).toContain("health");
    expect(calls).toContain("auto-delete:-1");
    expect(calls).not.toContain("unexpected-create");
    expect(calls).not.toContain("unexpected-upload");
    expect(calls).not.toContain("unexpected-preview");
  });

  test("only reuses dedicated private Lobu sandboxes", () => {
    expect(() =>
      assertReusableSandbox({
        name: "lobu-dev-test",
        public: false,
        labels: { app: "lobu", purpose: "remote-development" },
      })
    ).not.toThrow();
    expect(() =>
      assertReusableSandbox({
        name: "lobu-dev-test",
        public: true,
        labels: { app: "lobu", purpose: "remote-development" },
      })
    ).toThrow("is public");
    expect(() =>
      assertReusableSandbox({
        name: "lobu-dev-test",
        public: false,
        labels: { app: "other", purpose: "remote-development" },
      })
    ).toThrow("not labeled as Lobu remote development");
  });

  test("suppresses only confirmed session-not-found errors", async () => {
    await expect(
      deleteSessionIfPresent(
        {
          deleteSession: async () => {
            throw { response: { status: 404 } };
          },
        },
        "lobu-dev"
      )
    ).resolves.toBeUndefined();

    const authError = { response: { status: 401 } };
    await expect(
      deleteSessionIfPresent(
        {
          deleteSession: async () => {
            throw authError;
          },
        },
        "lobu-dev"
      )
    ).rejects.toBe(authError);
  });

  test("propagates session and log transport failures", async () => {
    const authError = { response: { status: 403 } };
    await expect(
      readSessionLogs(
        {
          getSession: async () => {
            throw authError;
          },
          getSessionCommandLogs: async () => ({}),
        },
        "lobu-dev"
      )
    ).rejects.toBe(authError);

    const networkError = { code: "ECONNRESET" };
    await expect(
      readSessionLogs(
        {
          getSession: async () => ({ commands: [{ id: "command-1" }] }),
          getSessionCommandLogs: async () => {
            throw networkError;
          },
        },
        "lobu-dev"
      )
    ).rejects.toBe(networkError);

    await expect(
      readSessionLogs(
        {
          getSession: async () => {
            throw { statusCode: 404 };
          },
          getSessionCommandLogs: async () => ({}),
        },
        "lobu-dev"
      )
    ).resolves.toBe("No remote development session exists yet.");
  });

  test("distinguishes an absent remote file from a read failure", async () => {
    await expect(
      readOptionalRemoteFile(
        { executeCommand: async () => ({ exitCode: 44, result: "" }) },
        "/remote/missing"
      )
    ).resolves.toBeUndefined();
    await expect(
      readOptionalRemoteFile(
        { executeCommand: async () => ({ exitCode: 0, result: "value\n" }) },
        "/remote/present"
      )
    ).resolves.toBe("value");
    await expect(
      readOptionalRemoteFile(
        {
          executeCommand: async () => ({
            exitCode: 1,
            result: "permission denied",
          }),
        },
        "/remote/unreadable"
      )
    ).rejects.toThrow(
      "Remote file read failed for /remote/unreadable: permission denied"
    );
  });

  test("never suspends a public or unrelated sandbox", async () => {
    let pauseCalls = 0;
    let stopCalls = 0;
    let autoDeleteCalls = 0;
    const pause = async () => {
      pauseCalls += 1;
    };
    const stop = async () => {
      stopCalls += 1;
    };
    const setAutoDeleteInterval = async () => {
      autoDeleteCalls += 1;
    };

    await expect(
      suspendSandbox(
        {
          labels: { app: "lobu", purpose: "remote-development" },
          name: "lobu-dev-test",
          pause,
          public: true,
          setAutoDeleteInterval,
          state: "started",
          stop,
        },
        false
      )
    ).rejects.toThrow("is public");
    await expect(
      suspendSandbox(
        {
          labels: { app: "other", purpose: "remote-development" },
          name: "lobu-dev-test",
          pause,
          public: false,
          setAutoDeleteInterval,
          state: "started",
          stop,
        },
        false
      )
    ).rejects.toThrow("not labeled as Lobu remote development");
    expect(pauseCalls).toBe(0);
    expect(stopCalls).toBe(0);
    expect(autoDeleteCalls).toBe(0);
  });
});
