/**
 * Tests for utils/urls.ts.
 *
 * No prior tests existed. Covers ensureBaseUrl edge cases.
 */

import { describe, expect, test } from "bun:test";
import { ensureBaseUrl } from "../utils/urls";

describe("ensureBaseUrl", () => {
  test("leaves https:// URLs unchanged", () => {
    expect(ensureBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com"
    );
  });

  test("leaves http:// URLs unchanged", () => {
    expect(ensureBaseUrl("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
  });

  test("prepends http:// to bare hostname", () => {
    expect(ensureBaseUrl("api.example.com")).toBe("http://api.example.com");
  });

  test("prepends http:// to localhost", () => {
    expect(ensureBaseUrl("localhost:8787")).toBe("http://localhost:8787");
  });

  test("prepends http:// to IP address", () => {
    expect(ensureBaseUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  test("does not double-prefix https:// URL", () => {
    const url = "https://secure.example.com/path";
    expect(ensureBaseUrl(url)).toBe(url);
  });

  test("does not modify URLs with paths when they start with https://", () => {
    expect(ensureBaseUrl("https://example.com/v1/api")).toBe(
      "https://example.com/v1/api"
    );
  });

  test("prepends http:// to a path-containing bare URL", () => {
    expect(ensureBaseUrl("example.com/api/v2")).toBe(
      "http://example.com/api/v2"
    );
  });
});
