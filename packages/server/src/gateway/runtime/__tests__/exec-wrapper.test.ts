import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

/**
 * The Vercel provider establishes the working directory inside the command it
 * runs, rather than issuing a separate `sandbox.fs.mkdir()` — that call was a
 * real command execution in the SDK, so it doubled the command-API rate and got
 * the sandbox rate-limited.
 *
 * The cwd and the command are passed as POSITIONAL ARGUMENTS. Prepending them
 * textually changed the meaning of the submitted command: `&&` binds tighter
 * than `&`, so `sleep 0 & pwd` backgrounded the cwd setup and escaped the
 * directory, and a comment-only command turned the trailing `&&` into a syntax
 * error. These tests run the real wrapper through a real bash.
 */

// Must stay byte-identical to the `args` in vercel.ts exec().
const WRAPPER = 'mkdir -p -- "$1" && cd -- "$1" && eval "$2"';

const workdir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "lobu-exec-wrapper-"))
);

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function runWrapped(cwd: string, command: string): { out: string; code: number } {
  try {
    const out = execFileSync(
      "/bin/bash",
      ["-lc", WRAPPER, "lobu-exec", cwd, command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { out: out.trim(), code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { out: (err.stdout ?? "").trim(), code: err.status ?? 1 };
  }
}

describe("remote exec wrapper", () => {
  test("runs the command in the requested directory", () => {
    const { out, code } = runWrapped(workdir, "pwd");
    expect(code).toBe(0);
    expect(out).toBe(workdir);
  });

  test("creates the directory when it does not exist yet", () => {
    const nested = path.join(workdir, "a", "b", "c");
    const { out, code } = runWrapped(nested, "pwd");
    expect(code).toBe(0);
    expect(out).toBe(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  test("a top-level & does not background the cwd setup", () => {
    // Regression: textual prepending made this `… && cd … && sleep 0` run in
    // the background while `pwd` ran separately in the default directory.
    const { out, code } = runWrapped(workdir, "sleep 0 & pwd");
    expect(code).toBe(0);
    expect(out).toBe(workdir);
  });

  test("a comment-only command is not a syntax error", () => {
    // Regression: a trailing `&&` before a comment consumed the rest of the
    // line, so bash reported "unexpected end of file".
    const { code } = runWrapped(workdir, "# just a note");
    expect(code).toBe(0);
  });

  test("the command's own exit code survives", () => {
    expect(runWrapped(workdir, "exit 3").code).toBe(3);
    expect(runWrapped(workdir, "true").code).toBe(0);
  });

  test("operators inside the command keep their meaning", () => {
    expect(runWrapped(workdir, "echo a && echo b").out).toBe("a\nb");
    expect(runWrapped(workdir, "false || echo fallback").out).toBe("fallback");
    expect(runWrapped(workdir, "echo x | tr x y").out).toBe("y");
  });

  test("a hostile cwd cannot break out of its argument", () => {
    // The path is an argv entry, never interpolated, so quotes in it are inert.
    const marker = path.join(workdir, "PWNED");
    const hostile = `${workdir}/'; touch ${marker}; '`;
    runWrapped(hostile, "pwd");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
