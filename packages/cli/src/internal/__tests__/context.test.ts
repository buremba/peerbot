import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import {
  addContext,
  DEFAULT_CONTEXT_NAME,
  findContextByMemoryUrl,
  findContextByUrl,
  getActiveOrg,
  getServerConfig,
  loadContextConfig,
  removeContext,
  setActiveOrg,
  setServerConfig,
} from "../context";

describe("context management", () => {
  let readFileSpy: ReturnType<typeof spyOn<typeof fs, "readFile">>;
  let writeFileSpy: ReturnType<typeof spyOn<typeof fs, "writeFile">>;

  beforeEach(() => {
    delete process.env.LOBU_CONTEXT;
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_URL;
    delete process.env.LOBU_MEMORY_URL;

    readFileSpy = spyOn(fs, "readFile");
    writeFileSpy = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    spyOn(fs, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  test("loadContextConfig handles missing file", async () => {
    readFileSpy.mockRejectedValue(new Error("File not found"));

    const config = await loadContextConfig();

    expect(config.currentContext).toBe(DEFAULT_CONTEXT_NAME);
    expect(config.contexts[DEFAULT_CONTEXT_NAME]).toBeDefined();
  });

  test("stores and reads the active org per context", async () => {
    const configData = {
      currentContext: "prod",
      contexts: {
        lobu: {
          apiUrl: "https://app.lobu.ai/api/v1",
          activeOrg: "default-org",
        },
        prod: { apiUrl: "https://prod.lobu.ai/api/v1", activeOrg: "prod-org" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getActiveOrg("lobu")).toBe("default-org");
    expect(await getActiveOrg("prod")).toBe("prod-org");
    expect(await getActiveOrg()).toBe("prod-org");

    await setActiveOrg("new-org", "lobu");
    const [, written] = writeFileSpy.mock.calls[0]!;
    const saved = JSON.parse(written as string) as typeof configData;
    expect(saved.contexts.lobu.activeOrg).toBe("new-org");
    expect(saved.contexts.prod.activeOrg).toBe("prod-org");
  });

  test("finds contexts by normalized API URL", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
        custom: { apiUrl: "https://custom.lobu.ai/api/v1" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const matched = await findContextByUrl("https://custom.lobu.ai/api/v1/");
    expect(matched?.name).toBe("custom");
    expect(matched?.apiUrl).toBe("https://custom.lobu.ai/api/v1");

    const none = await findContextByUrl("https://unknown.ai");
    expect(none).toBeUndefined();
  });

  test("finds contexts by normalized memory URL", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
        local: {
          apiUrl: "http://localhost:8787/api/v1",
          memoryUrl: "http://localhost:8787/mcp/acme",
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const matched = await findContextByMemoryUrl("http://localhost:8787/mcp");

    expect(matched?.name).toBe("local");
  });

  test("reads and persists the server block per context", async () => {
    const configData = {
      currentContext: "local",
      contexts: {
        local: {
          apiUrl: "http://localhost:8787/api/v1",
          server: {
            databaseUrl: "postgres://burakemre@localhost:5432/lobu",
            port: 9000,
            host: "0.0.0.0",
            dataDir: "/tmp/lobu-data",
          },
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("local")).toEqual({
      databaseUrl: "postgres://burakemre@localhost:5432/lobu",
      port: 9000,
      host: "0.0.0.0",
      dataDir: "/tmp/lobu-data",
    });

    await setServerConfig(
      { databaseUrl: "postgres://new/db", port: 8788 },
      "local"
    );
    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string) as typeof configData;
    expect(saved.contexts.local.server).toEqual({
      databaseUrl: "postgres://new/db",
      port: 8788,
    });
  });

  test("addContext stores optional server config (port + cwd + lifecycle)", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await addContext("verify-flow", "http://localhost:8788", {
      port: 8788,
      cwd: "/Users/me/Code/lobu/.claude/worktrees/verify-flow",
      lifecycle: "managed",
    });

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts["verify-flow"]).toEqual({
      apiUrl: "http://localhost:8788",
      server: {
        port: 8788,
        cwd: "/Users/me/Code/lobu/.claude/worktrees/verify-flow",
        lifecycle: "managed",
      },
    });
  });

  test("addContext refuses to overwrite the default context", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        contexts: {
          [DEFAULT_CONTEXT_NAME]: { apiUrl: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    await expect(
      addContext(DEFAULT_CONTEXT_NAME, "http://localhost:8788")
    ).rejects.toThrow(/Cannot overwrite the default context/);
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("addContext without server keeps shape backwards-compatible", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await addContext("plain", "https://example.com/api/v1");

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts.plain).toEqual({
      apiUrl: "https://example.com/api/v1",
    });
  });

  test("removeContext deletes the entry and resets currentContext if needed", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "verify-flow",
        contexts: {
          lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
          "verify-flow": { apiUrl: "http://localhost:8788" },
        },
      })
    );

    await removeContext("verify-flow");
    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts["verify-flow"]).toBeUndefined();
    expect(saved.currentContext).toBe(DEFAULT_CONTEXT_NAME);
  });

  test("removeContext is idempotent for missing entries", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await removeContext("never-existed");
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("removeContext refuses the default context", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        contexts: {
          [DEFAULT_CONTEXT_NAME]: { apiUrl: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    await expect(removeContext(DEFAULT_CONTEXT_NAME)).rejects.toThrow(
      /Cannot remove the default context/
    );
  });

  test("drops invalid server fields during normalization", async () => {
    const configData = {
      currentContext: "local",
      contexts: {
        local: {
          apiUrl: "http://localhost:8787/api/v1",
          server: {
            databaseUrl: "  ",
            port: -1,
            host: "   ",
            dataDir: "/cfg/data",
            // unknown field — should be ignored
            phaserBank: 5,
          },
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("local")).toEqual({ dataDir: "/cfg/data" });
  });
});
