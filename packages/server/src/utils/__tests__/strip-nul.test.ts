import { describe, expect, it } from "vitest";
import { stripNul, stripNulDeep } from "../strip-nul";

describe("stripNul", () => {
  it("returns the string unchanged when there is no NUL", () => {
    expect(stripNul("hello")).toBe("hello");
  });

  it("removes NUL bytes", () => {
    expect(stripNul("a\u0000b")).toBe("ab");
  });

  it("leaves other control chars (e.g. the jsonb-safe SOH delimiter) intact", () => {
    expect(stripNul("2026-06-27T23:00:00.000Z\u0001li_connection_x")).toBe(
      "2026-06-27T23:00:00.000Z\u0001li_connection_x",
    );
  });
});

describe("stripNulDeep", () => {
  it("strips NUL from a nested connector checkpoint (the LinkedIn takeout bug)", () => {
    // Reproduces the exact payload that 500ed /api/workers/complete with
    // "unsupported Unicode escape sequence": a composite cursor whose delimiter
    // was NUL, written into the jsonb checkpoint column.
    const checkpoint = {
      last_connections_timestamp:
        "2026-06-27T23:00:00.000Z\u0000li_connection_abc",
    };
    expect(stripNulDeep(checkpoint)).toEqual({
      last_connections_timestamp:
        "2026-06-27T23:00:00.000Zli_connection_abc",
    });
  });

  it("strips NUL from object keys, arrays, and deep nesting", () => {
    const input = {
      ["k\u0000ey"]: ["a\u0000b", { c: "d\u0000e" }],
    };
    expect(stripNulDeep(input)).toEqual({ key: ["ab", { c: "de" }] });
  });

  it("passes primitives and non-plain objects through untouched", () => {
    expect(stripNulDeep(42)).toBe(42);
    expect(stripNulDeep(null)).toBe(null);
    const d = new Date(0);
    expect(stripNulDeep(d)).toBe(d);
  });
});
