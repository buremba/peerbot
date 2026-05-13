/**
 * Tests for utils/network-domains.ts.
 *
 * normalizeDomainPattern and normalizeDomainPatterns are called by
 * the lobu.toml network config transformer. These tests harden the
 * contract so regressions in normalization are caught immediately.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeDomainPattern,
  normalizeDomainPatterns,
} from "../utils/network-domains";

describe("normalizeDomainPattern", () => {
  // Wildcard prefix conversion
  test("converts *.example.com to .example.com", () => {
    expect(normalizeDomainPattern("*.example.com")).toBe(".example.com");
  });

  test("converts *.sub.example.com to .sub.example.com", () => {
    expect(normalizeDomainPattern("*.sub.example.com")).toBe(
      ".sub.example.com"
    );
  });

  // Case normalization
  test("lowercases plain hostname", () => {
    expect(normalizeDomainPattern("API.GitHub.COM")).toBe("api.github.com");
  });

  test("lowercases *.domain", () => {
    expect(normalizeDomainPattern("*.EXAMPLE.COM")).toBe(".example.com");
  });

  // Path patterns (start with /): pass through unchanged
  test("passes through leading-slash patterns unchanged", () => {
    expect(normalizeDomainPattern("/mcp/github/tools/*")).toBe(
      "/mcp/github/tools/*"
    );
  });

  test("does not lowercase a slash-prefixed pattern", () => {
    // Leading / means it's treated as an MCP tool pattern, NOT a domain
    expect(normalizeDomainPattern("/MCP/GitHub/tools/*")).toBe(
      "/MCP/GitHub/tools/*"
    );
  });

  // Trimming
  test("trims leading and trailing whitespace", () => {
    expect(normalizeDomainPattern("  api.example.com  ")).toBe(
      "api.example.com"
    );
  });

  test("trims and normalizes wildcard with extra spaces", () => {
    expect(normalizeDomainPattern("  *.example.com  ")).toBe(".example.com");
  });

  // Already canonical forms
  test("leaves already-canonical .example.com unchanged", () => {
    expect(normalizeDomainPattern(".example.com")).toBe(".example.com");
  });

  test("leaves plain hostname unchanged", () => {
    expect(normalizeDomainPattern("api.github.com")).toBe("api.github.com");
  });

  // Star-only wildcard (edge)
  test("star-only becomes empty dot prefix (.)", () => {
    // "*.".slice(2) = "" → "." + "" = "."
    // This is an edge-case; document the actual behavior
    const result = normalizeDomainPattern("*.");
    expect(result).toBe(".");
  });
});

describe("normalizeDomainPatterns", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeDomainPatterns(undefined)).toBeUndefined();
  });

  test("returns empty array for empty input", () => {
    expect(normalizeDomainPatterns([])).toEqual([]);
  });

  test("normalizes and deduplicates patterns", () => {
    const result = normalizeDomainPatterns([
      "api.github.com",
      "API.github.com",
      "*.example.com",
      "*.EXAMPLE.COM",
    ]);
    // Dedup expects: api.github.com, .example.com (normalized forms)
    expect(result).toEqual(["api.github.com", ".example.com"]);
  });

  test("removes empty strings after normalization", () => {
    // An entry that becomes empty string after trim is filtered out
    const result = normalizeDomainPatterns(["  ", "api.example.com"]);
    // "  ".trim() = "" → filtered by filter(Boolean)
    expect(result).toEqual(["api.example.com"]);
  });

  test("preserves order of first occurrence after dedup", () => {
    const result = normalizeDomainPatterns([
      "b.example.com",
      "a.example.com",
      "b.example.com",
    ]);
    expect(result).toEqual(["b.example.com", "a.example.com"]);
  });

  test("handles mixed wildcard and exact domains", () => {
    const result = normalizeDomainPatterns([
      "*.slack.com",
      "api.github.com",
      "OPENAI.COM",
    ]);
    expect(result).toEqual([".slack.com", "api.github.com", "openai.com"]);
  });
});
