import { afterEach, describe, expect, test } from "bun:test";
import { buildMemoryPlugins } from "../config/index.js";

const originalPort = process.env.PORT;

afterEach(() => {
  if (originalPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = originalPort;
  }
});

describe("buildMemoryPlugins", () => {
  test("uses LOBU memory plugin when installed without MEMORY_URL", () => {
    process.env.PORT = "8787";

    expect(buildMemoryPlugins({ hasOwlettoPlugin: true })).toEqual([
      {
        source: "@lobu/openclaw-plugin",
        slot: "memory",
        enabled: true,
        config: {
          mcpUrl: "http://127.0.0.1:8787/lobu/mcp/lobu-memory",
          gatewayAuthUrl: "http://127.0.0.1:8787/lobu",
        },
      },
    ]);
  });

  test("falls back to native memory when LOBU memory plugin is unavailable", () => {
    expect(
      buildMemoryPlugins({
        hasOwlettoPlugin: false,
        hasNativeMemoryPlugin: true,
      })
    ).toEqual([
      {
        source: "@openclaw/native-memory",
        slot: "memory",
        enabled: true,
      },
    ]);
  });

  test("returns no plugin when neither LOBU memory nor native memory plugin exists", () => {
    expect(
      buildMemoryPlugins({
        hasOwlettoPlugin: false,
        hasNativeMemoryPlugin: false,
      })
    ).toEqual([]);
  });
});
