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

  test("passes fresh non-empty instructions through and remembers them", () => {
    const merged = withLastGoodMcpInstructions({ "lobu-memory": "v1" });
    expect(merged).toEqual({ "lobu-memory": "v1" });
  });

  test("a present-but-empty server falls back to its last-known-good value", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "good" });
    // Next turn: server still present in the response, but its instructions
    // blipped empty (transient gateway tool-fetch hiccup).
    const merged = withLastGoodMcpInstructions({ "lobu-memory": "" });
    expect(merged["lobu-memory"]).toBe("good"); // block does not disappear
  });

  test("an explicitly empty value does not overwrite the good value", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "good" });
    const merged = withLastGoodMcpInstructions({ "lobu-memory": "   " });
    expect(merged["lobu-memory"]).toBe("good");
  });

  test("fresh non-empty value supersedes the previous one", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "old" });
    const merged = withLastGoodMcpInstructions({ "lobu-memory": "new" });
    expect(merged["lobu-memory"]).toBe("new");
  });

  test("the block stays byte-stable when a PRESENT server blips empty", () => {
    const turn1 = buildMcpServerInstructions(
      withLastGoodMcpInstructions({ "lobu-memory": "schema block" })
    );
    // Server still present in the authoritative response but instructions empty.
    const turn2 = buildMcpServerInstructions(
      withLastGoodMcpInstructions({ "lobu-memory": "" })
    );
    expect(turn2).toBe(turn1);
  });

  test("a server ABSENT from an authoritative response is dropped", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "mem", slack: "slack text" });
    // Slack disconnected: next authoritative response omits it entirely.
    const merged = withLastGoodMcpInstructions({ "lobu-memory": "mem" });
    expect(merged.slack).toBeUndefined();
    expect(merged["lobu-memory"]).toBe("mem");
    // And it must not reappear on a later fetch.
    const later = withLastGoodMcpInstructions({ "lobu-memory": "mem" });
    expect(later.slack).toBeUndefined();
  });

  test("an empty authoritative response drops everything", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "mem" });
    expect(withLastGoodMcpInstructions({})).toEqual({});
  });

  test("present-but-empty with no prior value renders nothing", () => {
    const merged = withLastGoodMcpInstructions({ "brand-new": "" });
    expect(merged["brand-new"]).toBeUndefined();
  });
});
