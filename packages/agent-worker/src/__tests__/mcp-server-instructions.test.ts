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

  test("a transient empty fetch falls back to the last-known-good value", () => {
    withLastGoodMcpInstructions({ "lobu-memory": "good" });
    // Next turn: gateway tool-fetch blipped, entry arrives missing entirely.
    const merged = withLastGoodMcpInstructions({});
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

  test("the block stays byte-stable across a blip (no cache bust)", () => {
    const turn1 = buildMcpServerInstructions(
      withLastGoodMcpInstructions({ "lobu-memory": "schema block" })
    );
    const turn2 = buildMcpServerInstructions(
      withLastGoodMcpInstructions({}) // blip
    );
    expect(turn2).toBe(turn1);
  });
});
