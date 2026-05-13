/**
 * Tests for utils/json.ts.
 *
 * No prior tests existed. Covers safeJsonParse, toJsonSafe (bigint conversion),
 * and parseJsonObject. (safeJsonStringify is intentionally not exported.)
 */

import { describe, expect, test } from "bun:test";
import { parseJsonObject, safeJsonParse, toJsonSafe } from "../utils/json";

// ── safeJsonParse ────────────────────────────────────────────────────────────

describe("safeJsonParse", () => {
  test("parses valid JSON object", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test("parses valid JSON array", () => {
    expect(safeJsonParse<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("parses valid JSON string value", () => {
    expect(safeJsonParse<string>('"hello"')).toBe("hello");
  });

  test("parses valid JSON number", () => {
    expect(safeJsonParse<number>("42")).toBe(42);
  });

  test("parses valid JSON boolean", () => {
    expect(safeJsonParse<boolean>("true")).toBe(true);
  });

  test("parses null JSON literal", () => {
    expect(safeJsonParse("null")).toBeNull();
  });

  test("returns default null on invalid JSON", () => {
    expect(safeJsonParse("not json")).toBeNull();
  });

  test("returns custom fallback on invalid JSON", () => {
    expect(safeJsonParse("not json", "fallback")).toBe("fallback");
  });

  test("returns null fallback on empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });

  test("returns custom fallback on empty string", () => {
    const fallback = { default: true };
    expect(safeJsonParse("", fallback)).toBe(fallback);
  });

  test("type parameter is carried through", () => {
    const result = safeJsonParse<{ x: number }>('{"x":5}');
    expect(result?.x).toBe(5);
  });
});

// ── toJsonSafe ───────────────────────────────────────────────────────────────

describe("toJsonSafe", () => {
  test("passes through a plain object unchanged", () => {
    const obj = { a: 1, b: "x" };
    expect(toJsonSafe(obj)).toEqual(obj);
  });

  test("converts a safe BigInt to a number", () => {
    // toJsonSafe's static T = input shape (bigint), but the runtime value is
    // a number after JSON round-trip. Cast through unknown to assert that.
    const result = toJsonSafe({ count: BigInt(42) }) as unknown as {
      count: number;
    };
    expect(result.count).toBe(42);
    expect(typeof result.count).toBe("number");
  });

  test("converts an unsafe BigInt to a string", () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const result = toJsonSafe({ id: big }) as unknown as { id: string };
    expect(typeof result.id).toBe("string");
    expect(result.id).toBe(big.toString());
  });

  test("nested BigInt fields are converted", () => {
    const result = toJsonSafe({ nested: { x: BigInt(7) } });
    expect((result as any).nested.x).toBe(7);
  });

  test("arrays with BigInt elements are converted", () => {
    const result = toJsonSafe([BigInt(1), BigInt(2)]) as unknown as number[];
    expect(result).toEqual([1, 2]);
  });
});

// ── parseJsonObject ──────────────────────────────────────────────────────────

describe("parseJsonObject", () => {
  test("parses a JSON object string", () => {
    expect(parseJsonObject('{"x":1}')).toEqual({ x: 1 });
  });

  test("returns {} for null input", () => {
    expect(parseJsonObject(null)).toEqual({});
  });

  test("returns {} for undefined input", () => {
    expect(parseJsonObject(undefined)).toEqual({});
  });

  test("returns {} for empty string", () => {
    expect(parseJsonObject("")).toEqual({});
  });

  test("returns {} for invalid JSON string", () => {
    expect(parseJsonObject("not json")).toEqual({});
  });

  test("returns {} when JSON is a plain array", () => {
    expect(parseJsonObject("[1,2,3]")).toEqual({});
  });

  test("returns {} when JSON is a string value", () => {
    expect(parseJsonObject('"hello"')).toEqual({});
  });

  test("returns {} when JSON is a number", () => {
    expect(parseJsonObject("42")).toEqual({});
  });

  test("passes through a plain object directly", () => {
    const obj = { a: 1 };
    expect(parseJsonObject(obj)).toBe(obj);
  });

  test("returns {} for a non-object (array) value", () => {
    expect(parseJsonObject([1, 2])).toEqual({});
  });

  test("returns {} for a non-object number value", () => {
    expect(parseJsonObject(42)).toEqual({});
  });
});
