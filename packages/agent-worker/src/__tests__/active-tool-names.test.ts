import { describe, expect, test } from "bun:test";
import { activeToolNames } from "../openclaw/active-tool-names";

/**
 * Regression for the pi 0.73.x P0: `options.tools` is a HARD allowlist, so the
 * list handed to createAgentSession MUST include the customTool names or every
 * MCP/built-in custom tool (ask_user, memory, query_sql, image/audio, plugins)
 * is filtered out before the model — agents were left with only the base
 * built-ins (read/write/edit/bash/grep/find/ls).
 */
describe("activeToolNames — pi treats `tools` as a hard allowlist", () => {
  test("unions base AND custom tool names (custom must survive the allowlist)", () => {
    const base = [{ name: "read" }, { name: "bash" }];
    const custom = [
      { name: "ask_user" },
      { name: "search_memory" },
      { name: "query_sql" },
    ];

    const names = activeToolNames(base, custom);

    expect(names).toEqual([
      "read",
      "bash",
      "ask_user",
      "search_memory",
      "query_sql",
    ]);
    // The exact P0: dropping these made every custom tool vanish from the agent.
    for (const c of custom) {
      expect(names).toContain(c.name);
    }
  });

  test("custom tools survive alongside the full bare built-in set", () => {
    const base = ["read", "write", "edit", "bash", "grep", "find", "ls"].map(
      (name) => ({ name })
    );
    const custom = [{ name: "ask_user" }, { name: "save_memory" }];

    const names = activeToolNames(base, custom);

    expect(names).toContain("ask_user");
    expect(names).toContain("save_memory");
    expect(names.length).toBe(base.length + custom.length);
  });

  test("empty custom set yields exactly the base names (no accidental extras)", () => {
    expect(activeToolNames([{ name: "bash" }], [])).toEqual(["bash"]);
  });
});
