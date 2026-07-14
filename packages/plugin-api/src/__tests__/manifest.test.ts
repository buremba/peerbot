import { describe, expect, test } from "bun:test";
import { defineLobuPlugin, LOBU_PLUGIN_API_VERSION } from "../index";

describe("defineLobuPlugin", () => {
  test("accepts a valid native plugin", () => {
    const plugin = defineLobuPlugin({
      manifest: {
        name: "lobu-runtime",
        version: "1.0.0",
        apiVersion: LOBU_PLUGIN_API_VERSION,
        description: "Lobu-owned runtime contributions",
        capabilities: ["memory.read"],
      },
    });

    expect(plugin.manifest.name).toBe("lobu-runtime");
  });

  test("rejects invalid names and unknown manifest fields", () => {
    expect(() =>
      defineLobuPlugin({
        manifest: {
          name: "Invalid Plugin",
          version: "1.0.0",
          apiVersion: LOBU_PLUGIN_API_VERSION,
          description: "invalid",
          legacy: true,
        } as never,
      })
    ).toThrow("Invalid Lobu plugin manifest");
  });
});
