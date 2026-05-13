/**
 * Tests for agent-store.ts utility functions and type contracts.
 *
 * Only inferGrantKind is a runtime function here. The rest of the module
 * is interface/type definitions. Tests focus on inferGrantKind's semantics.
 */

import { describe, expect, test } from "bun:test";
import { inferGrantKind } from "../agent-store";

describe("inferGrantKind", () => {
  test("patterns starting with / are mcp_tool grants", () => {
    expect(inferGrantKind("/mcp/gmail/tools/send_email")).toBe("mcp_tool");
  });

  test("wildcard mcp tool pattern is mcp_tool", () => {
    expect(inferGrantKind("/mcp/linear/tools/*")).toBe("mcp_tool");
  });

  test("bare hostname is a domain grant", () => {
    expect(inferGrantKind("api.github.com")).toBe("domain");
  });

  test("wildcard domain (canonical form) is a domain grant", () => {
    expect(inferGrantKind(".example.com")).toBe("domain");
  });

  test("wildcard domain (*.prefix) is a domain grant", () => {
    expect(inferGrantKind("*.example.com")).toBe("domain");
  });

  test("empty string is a domain grant (doesn't start with /)", () => {
    expect(inferGrantKind("")).toBe("domain");
  });

  test("star wildcard is a domain grant", () => {
    expect(inferGrantKind("*")).toBe("domain");
  });

  test("URL with https:// is a domain grant", () => {
    // URLs don't start with /
    expect(inferGrantKind("https://example.com")).toBe("domain");
  });
});
