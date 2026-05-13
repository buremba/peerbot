/**
 * Tests for utils/env.ts.
 *
 * No prior tests existed. Covers getRequiredEnv, getOptionalEnv,
 * getOptionalNumber, and getOptionalBoolean edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getOptionalBoolean,
  getOptionalEnv,
  getOptionalNumber,
  getRequiredEnv,
} from "../utils/env";

const VAR = "__TEST_LOBU_ENV_UTIL__";

function set(value: string) {
  process.env[VAR] = value;
}

function unset() {
  delete process.env[VAR];
}

beforeEach(unset);
afterEach(unset);

// ── getRequiredEnv ────────────────────────────────────────────────────────────

describe("getRequiredEnv", () => {
  test("returns value when env var is set", () => {
    set("my-value");
    expect(getRequiredEnv(VAR)).toBe("my-value");
  });

  test("throws ConfigError when env var is missing", () => {
    expect(() => getRequiredEnv(VAR)).toThrow(/Missing required/);
  });

  test("throws when env var is empty string", () => {
    set("");
    // empty string is falsy — treated as missing
    expect(() => getRequiredEnv(VAR)).toThrow();
  });
});

// ── getOptionalEnv ────────────────────────────────────────────────────────────

describe("getOptionalEnv", () => {
  test("returns env var value when set", () => {
    set("hello");
    expect(getOptionalEnv(VAR, "default")).toBe("hello");
  });

  test("returns default when env var is not set", () => {
    expect(getOptionalEnv(VAR, "default")).toBe("default");
  });

  test("returns undefined when env var absent and no default", () => {
    expect(getOptionalEnv(VAR)).toBeUndefined();
  });

  test("returns default when env var is empty string (falsy)", () => {
    set("");
    // process.env[VAR] = "" is falsy → falls back to default
    expect(getOptionalEnv(VAR, "default")).toBe("default");
  });
});

// ── getOptionalNumber ─────────────────────────────────────────────────────────

describe("getOptionalNumber", () => {
  test("returns parsed integer when valid", () => {
    set("42");
    expect(getOptionalNumber(VAR, 0)).toBe(42);
  });

  test("returns default when env var is not set", () => {
    expect(getOptionalNumber(VAR, 99)).toBe(99);
  });

  test("throws ConfigError for non-numeric value", () => {
    set("not-a-number");
    expect(() => getOptionalNumber(VAR, 0)).toThrow(/Invalid number/);
  });

  test("parses negative integer", () => {
    set("-5");
    expect(getOptionalNumber(VAR, 0)).toBe(-5);
  });

  test("parses zero", () => {
    set("0");
    expect(getOptionalNumber(VAR, 99)).toBe(0);
  });

  test("truncates float to integer (parseInt semantics)", () => {
    set("3.9");
    expect(getOptionalNumber(VAR, 0)).toBe(3);
  });

  test("throws for float-only string that parseInt returns NaN for", () => {
    set(".5");
    // parseInt(".5") = NaN
    expect(() => getOptionalNumber(VAR, 0)).toThrow(/Invalid number/);
  });
});

// ── getOptionalBoolean ────────────────────────────────────────────────────────

describe("getOptionalBoolean", () => {
  test("returns true for 'true'", () => {
    set("true");
    expect(getOptionalBoolean(VAR, false)).toBe(true);
  });

  test("returns true for '1'", () => {
    set("1");
    expect(getOptionalBoolean(VAR, false)).toBe(true);
  });

  test("returns true for 'yes'", () => {
    set("yes");
    expect(getOptionalBoolean(VAR, false)).toBe(true);
  });

  test("is case-insensitive for truthy values", () => {
    set("TRUE");
    expect(getOptionalBoolean(VAR, false)).toBe(true);
    set("Yes");
    expect(getOptionalBoolean(VAR, false)).toBe(true);
  });

  test("returns false for 'false'", () => {
    set("false");
    expect(getOptionalBoolean(VAR, true)).toBe(false);
  });

  test("returns false for '0'", () => {
    set("0");
    expect(getOptionalBoolean(VAR, true)).toBe(false);
  });

  test("returns false for arbitrary non-truthy string", () => {
    set("no");
    expect(getOptionalBoolean(VAR, true)).toBe(false);
  });

  test("returns default when env var is not set", () => {
    expect(getOptionalBoolean(VAR, true)).toBe(true);
    expect(getOptionalBoolean(VAR, false)).toBe(false);
  });

  test("returns default when env var is empty string", () => {
    set("");
    expect(getOptionalBoolean(VAR, true)).toBe(true);
  });
});
