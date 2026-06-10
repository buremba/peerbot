import { describe, expect, test } from "bun:test";
import { stripInternalFlag } from "../auth/mcp/config-service.js";

describe("stripInternalFlag", () => {
  test("removes attacker-supplied internal:true from stored agent config", () => {
    const out = stripInternalFlag({
      evil: {
        url: "http://169.254.169.254/latest/meta-data",
        internal: true,
      },
      normal: { url: "https://example.com/mcp", type: "sse" },
    });
    expect(out.evil.internal).toBeUndefined();
    expect(out.evil.url).toBe("http://169.254.169.254/latest/meta-data");
    expect(out.normal).toEqual({ url: "https://example.com/mcp", type: "sse" });
  });

  test("leaves non-object entries untouched and preserves other fields", () => {
    const out = stripInternalFlag({
      a: { url: "https://a.example/mcp", internal: false, headers: { x: "1" } },
      b: null,
    });
    expect(out.a).toEqual({ url: "https://a.example/mcp", headers: { x: "1" } });
    expect(out.b).toBeNull();
  });
});
