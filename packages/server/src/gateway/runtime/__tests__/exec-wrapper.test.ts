import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { execArgv } from "../providers/vercel.js";

/**
 * The provider establishes the working directory inside the command it runs
 * rather than issuing a separate `sandbox.fs.mkdir()` — the SDK implements that
 * as a real command execution, so it doubled the command-API rate and got the
 * sandbox rate-limited.
 *
 * These tests run the PROVIDER'S OWN argv through a real bash, so the wrapper
 * cannot drift from what production sends. The contract being defended: the
 * submitted command must behave exactly as it would under a plain
 * `/bin/bash -lc <command>`, only with the cwd already established.
 */

const workdir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "lobu-exec-wrapper-"))
);

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function wrapped(cwd: string, command: string): { out: string; code: number } {
  try {
    // codeql[js/shell-command-injection-from-environment]: the temp path reaches
    // bash as a positional argv entry (`"$1"`), never interpolated into the
    // script text — which is precisely the property the hostile-cwd test below
    // asserts. The directory is this test's own mkdtemp, not attacker input.
    const out = execFileSync("/bin/bash", execArgv(cwd, command), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out: out.trim(), code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { out: (err.stdout ?? "").trim(), code: err.status ?? 1 };
  }
}

/** The same command under a plain login shell — the behaviour to match. */
function direct(command: string): { out: string; code: number } {
  try {
    const out = execFileSync("/bin/bash", ["-lc", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out: out.trim(), code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { out: (err.stdout ?? "").trim(), code: err.status ?? 1 };
  }
}

describe("remote exec wrapper", () => {
  test("runs the command in the requested directory", () => {
    const { out, code } = wrapped(workdir, "pwd");
    expect(code).toBe(0);
    expect(out).toBe(workdir);
  });

  test("creates the directory when it does not exist yet", () => {
    const nested = path.join(workdir, "a", "b", "c");
    expect(wrapped(nested, "pwd").out).toBe(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  test("positional parameters match a direct bash -lc", () => {
    // Regression: running the command with `eval` in the wrapper shell leaked
    // its state — $0 became "lobu-exec", $1 the cwd, $# 2. A command reading
    // $1 or "$@" would see wrapper internals instead of nothing.
    const probe = 'echo "0=[$0] 1=[$1] n=[$#] all=[$*]"';
    expect(wrapped(workdir, probe).out).toBe(direct(probe).out);
  });

  test("a top-level & does not background the cwd setup", () => {
    // Regression: textual prepending made `&&` bind tighter than `&`, so the
    // cwd setup ran in the background and `pwd` escaped the directory.
    expect(wrapped(workdir, "sleep 0 & pwd").out).toBe(workdir);
  });

  test("a comment-only command is not a syntax error", () => {
    // Regression: a trailing `&&` before a comment consumed the rest of the
    // line — "syntax error: unexpected end of file".
    expect(wrapped(workdir, "# just a note").code).toBe(0);
  });

  test("the command's own exit code survives", () => {
    expect(wrapped(workdir, "exit 3").code).toBe(3);
    expect(wrapped(workdir, "true").code).toBe(0);
  });

  test("operators inside the command keep their meaning", () => {
    for (const command of [
      "echo a && echo b",
      "false || echo fallback",
      "echo x | tr x y",
      "for i in 1 2; do echo $i; done",
    ]) {
      expect(wrapped(workdir, command).out).toBe(direct(command).out);
    }
  });

  test("the command still runs in a login shell", () => {
    expect(wrapped(workdir, "shopt -q login_shell && echo yes || echo no").out).toBe(
      "yes"
    );
  });

  test("a hostile cwd cannot break out of its argument", () => {
    // The path is an argv entry, never interpolated, so quotes in it are inert.
    const marker = path.join(workdir, "PWNED");
    wrapped(`${workdir}/'; touch ${marker}; '`, "pwd");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
