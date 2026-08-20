import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function command(cwd: string, args: string[], env?: Record<string, string>) {
  return Bun.spawnSync(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return (
    new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr)
  );
}

describe("task-clean worktree removal", () => {
  it("prunes stale metadata after Git rejects a submodule worktree removal", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-task-clean-test-"));
    temporaryDirectories.push(root);
    const repo = join(root, "repo");
    const worktree = join(repo, ".claude", "worktrees", "task-clean");
    const bin = join(root, "bin");
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(
      resolve(import.meta.dir, "..", "task-clean.sh"),
      join(repo, "scripts", "task-clean.sh")
    );
    copyFileSync(
      resolve(import.meta.dir, "..", "lib", "db-name.sh"),
      join(repo, "scripts", "lib", "db-name.sh")
    );

    expect(command(root, ["git", "init", "-q", repo]).exitCode).toBe(0);
    expect(
      command(repo, ["git", "config", "user.email", "test@example.com"])
        .exitCode
    ).toBe(0);
    expect(command(repo, ["git", "config", "user.name", "Test"]).exitCode).toBe(
      0
    );
    expect(command(repo, ["git", "add", "scripts"]).exitCode).toBe(0);
    expect(command(repo, ["git", "commit", "-qm", "fixture"]).exitCode).toBe(0);
    expect(
      command(repo, [
        "git",
        "worktree",
        "add",
        "-b",
        "feat/task-clean",
        worktree,
      ]).exitCode
    ).toBe(0);

    // Older Git releases reject this operation before removing the registration.
    const gitShim = join(bin, "git");
    writeFileSync(
      gitShim,
      `#!/usr/bin/env bash
if [[ " $* " == *" worktree remove "* ]]; then
  printf '%s\\n' 'fatal: working trees containing submodules cannot be moved or removed' >&2
  exit 1
fi
exec /usr/bin/git "$@"
`
    );
    chmodSync(gitShim, 0o755);

    const result = command(
      repo,
      ["bash", "scripts/task-clean.sh", "task-clean", "--force"],
      {
        PATH: `${bin}:/usr/bin:/bin`,
      }
    );
    expect(result.exitCode, output(result)).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(
      command(repo, [
        "git",
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feat/task-clean",
      ]).exitCode
    ).not.toBe(0);
    expect(
      output(command(repo, ["git", "worktree", "list", "--porcelain"]))
    ).not.toContain(`worktree ${worktree}`);
  });
});
