import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildMcpServerInstructions,
  resetLastGoodMcpInstructions,
  withLastGoodMcpInstructions,
} from "../openclaw/session-context";

describe("buildMcpServerInstructions", () => {
  test("renders entries in stable sorted order regardless of key order", () => {
    const a = buildMcpServerInstructions({
      slack: "slack text",
      "lobu-memory": "memory text",
      github: "github text",
    });
    const b = buildMcpServerInstructions({
      github: "github text",
      "lobu-memory": "memory text",
      slack: "slack text",
    });
    // Byte-identical regardless of insertion order -> no cache churn.
    expect(a).toBe(b);
    // Sorted: github < lobu-memory < slack
    expect(a.indexOf("### github")).toBeLessThan(a.indexOf("### lobu-memory"));
    expect(a.indexOf("### lobu-memory")).toBeLessThan(a.indexOf("### slack"));
  });

  test("empty map produces empty string", () => {
    expect(buildMcpServerInstructions({})).toBe("");
    expect(buildMcpServerInstructions({ foo: "" })).toBe("");
  });
});

describe("withLastGoodMcpInstructions", () => {
  beforeEach(() => resetLastGoodMcpInstructions());

  // The gateway sets mcpInstructions[id] ONLY when a fetch succeeds with text
  // (gateway/index.ts: `if (result.value.instructions)`). So a blip shows up as
  // a server present in mcpStatus (knownServerIds) but ABSENT from fresh — not
  // as an empty string. These tests use the real (fresh, knownServerIds) shape.
  const ids = (...xs: string[]) => xs;

  test("passes fresh non-empty instructions through and remembers them", () => {
    const merged = withLastGoodMcpInstructions(
      { "lobu-memory": "v1" },
      ids("lobu-memory")
    );
    expect(merged).toEqual({ "lobu-memory": "v1" });
  });

  test("a known server MISSING from fresh (the real blip) uses last-good", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "good" }, ids("lobu-memory"));
    // Next turn: 401/init blip — server still in mcpStatus, but no instructions
    // key in the response. This is the actual gateway failure shape.
    const merged = withLastGoodMcpInstructions({}, ids("lobu-memory"));
    expect(merged["lobu-memory"]).toBe("good"); // block does not disappear
  });

  test("fresh non-empty value supersedes the previous one", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "old" }, ids("lobu-memory"));
    const merged = withLastGoodMcpInstructions(
      { "lobu-memory": "new" },
      ids("lobu-memory")
    );
    expect(merged["lobu-memory"]).toBe("new");
  });

  test("the block stays byte-stable across a real blip (no cache bust)", () => {
    const turn1 = buildMcpServerInstructions(
      withLastGoodMcpInstructions(
        { "lobu-memory": "schema block" },
        ids("lobu-memory")
      )
    );
    // Blip: still known, instructions key absent.
    const turn2 = buildMcpServerInstructions(
      withLastGoodMcpInstructions({}, ids("lobu-memory"))
    );
    expect(turn2).toBe(turn1);
  });

  test("a server removed from mcpStatus is dropped even if last-good has it", () => {
    withLastGoodMcpInstructions(
      { "lobu-memory": "mem", slack: "slack text" },
      ids("lobu-memory", "slack")
    );
    // Slack disconnected: it's gone from mcpStatus (knownServerIds) entirely.
    const merged = withLastGoodMcpInstructions(
      { "lobu-memory": "mem" },
      ids("lobu-memory")
    );
    expect(merged.slack).toBeUndefined();
    expect(merged["lobu-memory"]).toBe("mem");
    // Must not resurrect on a later fetch either.
    const later = withLastGoodMcpInstructions(
      { "lobu-memory": "mem" },
      ids("lobu-memory")
    );
    expect(later.slack).toBeUndefined();
  });

  test("empty knownServerIds drops everything (no servers exist)", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "mem" }, ids("lobu-memory"));
    expect(withLastGoodMcpInstructions({}, ids())).toEqual({});
  });

  test("a known server with no text anywhere yet renders nothing", () => {
    const merged = withLastGoodMcpInstructions({}, ids("brand-new"));
    expect(merged["brand-new"]).toBeUndefined();
  });
});
