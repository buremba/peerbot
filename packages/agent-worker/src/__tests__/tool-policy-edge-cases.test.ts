/**
 * Tool-Policy Edge-Case Tests
 *
 * Supplements the main tool-policy.test.ts with cases that were missing:
 *
 *   - isDirectPackageInstallCommand: compound commands, piped package installs,
 *     edge cases that should NOT be caught (false positives)
 *   - enforceBashCommandPolicy: empty allow-prefixes with allowAll=false
 *     (no filter = pass-through) versus explicit empty allow-prefixes
 *   - buildToolPolicy: wildcard prefix matching (e.g. "Read*")
 *   - normalizeToolList: mixed array with numbers coerced to strings
 *   - isToolAllowedByPolicy: tool name with trailing/leading whitespace in policy
 *   - Bash deny entries do NOT block other tool names that happen to start with "Bash"
 */

import { describe, expect, test } from "bun:test";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isDirectPackageInstallCommand,
  isToolAllowedByPolicy,
  normalizeToolList,
  type BashCommandPolicy,
} from "../runtime/tool-policy";

// ---------------------------------------------------------------------------
// isDirectPackageInstallCommand
// ---------------------------------------------------------------------------

describe("isDirectPackageInstallCommand", () => {
  // Should detect
  const detected = [
    "npm install lodash",
    "npm i lodash",
    "npm install",
    "pnpm add react",
    "pnpm install",
    "yarn add typescript",
    "yarn install",
    "bun install",
    "bun add express",
    "pip install requests",
    "pip3 install requests",
    "uv pip install pandas",
    "cargo install ripgrep",
    "go install golang.org/x/tools/gopls@latest",
    "gem install bundler",
    "poetry add numpy",
    "composer require monolog/monolog",
    "apt install curl",
    "apt-get install -y ffmpeg",
    "sudo apt install curl",
    "sudo apt-get install curl",
    "brew install wget",
    "apk add bash",
    // piped / chained
    "echo hi | npm install",
    "true && npm install foo",
    "npm install; echo done",
    // quoted inside
    "bash -c 'npm install foo'",
  ];

  for (const cmd of detected) {
    test(`detects package install: ${cmd}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    });
  }

  // Should NOT detect (false positive guard).
  // Note: "brew list" IS detected (brew prefix matches) — intentionally conservative.
  // Note: "apt-get update" IS detected (apt-get prefix matches) — intentionally conservative.
  // Note: "echo npm install" IS detected via regex (embedded npm install) — intentionally conservative.
  const allowed = [
    "",
    "   ",
    "git status",
    "npm run build", // npm run ≠ npm install
    "npm test",
    "npm start",
    "npx create-react-app my-app", // npx not npm install
    "pip list", // pip list ≠ pip install
    "pip show requests",
    "pnpm run dev",
    "bun run dev",
    "bun test",
    "yarn run test",
    "cargo build",
    "go build ./...",
    "gem list",
    "cat npm-install.log",
  ];

  for (const cmd of allowed) {
    test(`does not falsely detect: ${cmd || "(empty)"}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    });
  }

  // Conservative over-detection: document actual behavior to catch regressions
  test("brew list IS detected (brew prefix is in deny list — conservative)", () => {
    expect(isDirectPackageInstallCommand("brew list")).toBe(true);
  });

  test("apt-get update IS detected (apt-get prefix is in deny list — conservative)", () => {
    expect(isDirectPackageInstallCommand("apt-get update")).toBe(true);
  });

  test("echo npm install IS detected (regex matches embedded npm install)", () => {
    // The DIRECT_PACKAGE_INSTALL_PATTERNS match npm install anywhere in the command
    expect(isDirectPackageInstallCommand("echo npm install")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDirectPackageInstallCommand — nix new-style CLI and ad-hoc package runners
// ---------------------------------------------------------------------------

describe("isDirectPackageInstallCommand nix and ad-hoc runner coverage", () => {
  // These nix commands can fetch, realize, or execute store content. The same
  // gate covers direct tool mutations and one-shot package runners. npx/bunx
  // remain allowed because they prefer already-installed local binaries.
  const detected = [
    "nix shell nixpkgs#git -c git push",
    "nix run nixpkgs#hello",
    "nix develop",
    "nix build nixpkgs#hello",
    "nix profile install nixpkgs#hello",
    "nix flake update",
    "nix eval --expr 'builtins.fetchurl http://example.com'",
    "nix-build '<nixpkgs>' -A hello",
    "nix-store --realise /nix/store/abc",
    "nix-channel --update",
    "nix-prefetch-url https://example.com/x.tar.gz",
    "nix-copy-closure --from host /nix/store/abc",
    "/usr/bin/nix shell nixpkgs#git",
    "/usr/bin/nix-store --realise /nix/store/abc",
    "bash -c 'nix repl'",
    "bash -c 'nix --option substituters https://cache.example build nixpkgs#hello'",
    "/usr/bin/nix --extra-experimental-features nix-command run nixpkgs#hello",
    "sudo nix shell nixpkgs#git",
    "pipx install httpie",
    "pipx run cowsay moo",
    "pipx upgrade httpie",
    "pipx reinstall httpie",
    "uvx cowsay moo",
    "/usr/bin/uvx cowsay moo",
    "uv tool install ruff",
    "uv tool run ruff check",
    "uv tool upgrade ruff",
    "uv add requests",
    "pnpm dlx create-react-app my-app",
    "/usr/local/bin/pnpm dlx create-react-app my-app",
    "yarn dlx create-react-app my-app",
    "echo hi && nix run nixpkgs#hello",
    "true; nix shell nixpkgs#curl -c curl http://example.com",
  ];

  for (const cmd of detected) {
    test(`detects package acquisition: ${cmd}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    });
  }

  // False-positive guards: "nix" in prose or as part of another command name
  // must not trip the gate, and non-acquisition commands stay usable.
  const allowed = [
    "nixfmt flake.nix",
    "git commit -m 'nix support'",
    "cat nix/store/list.txt",
    "uv pip list",
    // Intentionally allowed like cargo/go builds, though it may sync a project.
    "uv run script.py",
    "uv tool list",
    "yarn run dlx-helper",
    "pipx list",
  ];

  for (const cmd of allowed) {
    test(`does not falsely detect: ${cmd}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isDirectPackageInstallCommand — escaped executable names must not bypass
// ---------------------------------------------------------------------------

describe("isDirectPackageInstallCommand escaped-name bypass", () => {
  // The shell strips a backslash before an ordinary character, so `n\ix shell`
  // resolves to `nix shell` at execution. The detector must canonicalize those
  // escapes before matching or the whole gate is bypassable one backslash at a
  // time. (Reported by the review of PR #2259.)
  const escaped = [
    "n\\ix shell nixpkgs#git",
    "ni\\x run nixpkgs#hello",
    "\\nix build nixpkgs#hello",
    "n\\i\\x develop",
    "u\\vx cowsay",
    "pip\\x run cowsay",
    "np\\m install lodash",
    "echo hi && n\\ix run nixpkgs#hello",
  ];
  for (const cmd of escaped) {
    test(`detects escaped acquisition: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// isDirectPackageInstallCommand — quoted data must not be treated as a command
// ---------------------------------------------------------------------------

describe("isDirectPackageInstallCommand quoted-data false positives", () => {
  // A package-manager phrase inside a quoted argument is DATA, not a command.
  // The detector must inspect per shell segment (quotes stripped) so ordinary
  // prose — commit messages, echoed help text — is not blocked.
  // (Reported by the review of PR #2259.)
  const quoted = [
    'echo "nix shell"',
    'git commit -m "nix shell support"',
    "git commit -m 'add nix run helper'",
    'echo "uvx foo"',
    'echo "run npm install to set up"',
    'printf "%s\\n" "pnpm dlx create-x"',
    'grep "nix build" changelog.md',
  ];
  for (const cmd of quoted) {
    test(`does not falsely detect quoted data: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    });
  }

  // Guard the guard: a real command chained AFTER quoted data is still caught.
  test("real acquisition after quoted data is still detected", () => {
    expect(
      isDirectPackageInstallCommand('echo "nix docs"; nix run nixpkgs#hello')
    ).toBe(true);
    expect(isDirectPackageInstallCommand('echo "safe" && uvx cowsay')).toBe(
      true
    );
  });

  // The quoted body of an interpreter wrapper IS a command, not data, so it
  // must still be inspected — including when the -c flag is bundled with other
  // flags (`-lc`, `-xc`) or the wrapper is sudo/chained. This is the one place
  // quoted content is executable rather than an argument.
  const interpreterBodies = [
    "bash -c 'npm install foo'",
    "bash -c 'nix repl'",
    'sh -c "nix run nixpkgs#hello"',
    "bash -lc 'nix build nixpkgs#hello'",
    "bash -xc 'uvx cowsay'",
    "sudo bash -c 'pipx run x'",
    "zsh -c 'pnpm dlx create-x'",
    "echo hi; bash -c 'nix run x'",
    "bash -c 'n\\ix shell y'",
  ];
  for (const cmd of interpreterBodies) {
    test(`inspects interpreter -c body: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    });
  }

  // But an interpreter wrapper running a BENIGN body is not falsely flagged.
  const benignBodies = [
    "bash -c 'echo hello'",
    "bash -c 'git status'",
    "sh -c 'ls -la'",
    "bash -lc 'uv run app.py'",
  ];
  for (const cmd of benignBodies) {
    test(`does not falsely flag benign -c body: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    });
  }

  // Fail-closed generalization: ANY leading command that is not a known
  // data-only command has its quoted content inspected as code — not just the
  // sh/bash/-c family. `eval`, path-qualified interpreters, and command
  // wrappers all execute their quoted argument. (Second review of PR #2259.)
  const executorBodies = [
    "eval 'npm install lodash'",
    'eval "nix run nixpkgs#hello"',
    "eval 'uvx cowsay'",
    "sudo eval 'pipx run x'",
    "/bin/sh -c 'npm install'",
    "/usr/bin/bash -c 'nix build x'",
    "command eval 'npm install x'",
    "builtin eval 'npm install x'",
    "xargs -I{} nix run {}", // no quotes, but the acquisition is unquoted anyway
    "echo safe; eval 'nix run x'", // chained after benign data-only command
  ];
  for (const cmd of executorBodies) {
    test(`inspects non-sh executor quoted body: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    });
  }

  // Benign executor bodies are still not falsely flagged.
  const benignExecutorBodies = [
    "eval 'echo hello'",
    'eval "$(some-cmd)"',
    "/bin/sh -c 'ls -la'",
  ];
  for (const cmd of benignExecutorBodies) {
    test(`does not falsely flag benign executor body: ${JSON.stringify(cmd)}`, () => {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// normalizeToolList edge cases
// ---------------------------------------------------------------------------

describe("normalizeToolList edge cases", () => {
  test("numbers in array are coerced to strings", () => {
    // @ts-expect-error: intentional wrong type to test coercion
    expect(normalizeToolList([1, 2, 3])).toEqual(["1", "2", "3"]);
  });

  test("mixed newline + comma separation", () => {
    expect(normalizeToolList("Read,Write\nEdit")).toEqual([
      "Read",
      "Write",
      "Edit",
    ]);
  });

  test("single entry with no delimiter", () => {
    expect(normalizeToolList("Read")).toEqual(["Read"]);
  });

  test("only whitespace entries are all filtered out", () => {
    expect(normalizeToolList("   ,  ,  \n  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildToolPolicy: wildcard prefix pattern
// ---------------------------------------------------------------------------

describe("buildToolPolicy wildcard prefix", () => {
  test("Bash(git:*) in allowed extracts 'git' prefix", () => {
    const policy = buildToolPolicy({ allowedTools: ["Bash(git:*)"] });
    expect(policy.bashPolicy.allowPrefixes).toContain("git");
  });

  test("wildcard prefix 'Read*' in allowedPatterns matches ReadFile and ReadDir", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true },
      allowedTools: ["Read*"],
    });
    expect(isToolAllowedByPolicy("ReadFile", policy)).toBe(true);
    expect(isToolAllowedByPolicy("ReadDir", policy)).toBe(true);
    expect(isToolAllowedByPolicy("WriteFile", policy)).toBe(false);
  });

  test("wildcard '*' in deniedPatterns blocks everything", () => {
    const policy = buildToolPolicy({ disallowedTools: ["*"] });
    expect(isToolAllowedByPolicy("Read", policy)).toBe(false);
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isToolAllowedByPolicy edge cases
// ---------------------------------------------------------------------------

describe("isToolAllowedByPolicy edge cases", () => {
  test("tool name with leading/trailing whitespace in policy entry is trimmed and matched", () => {
    const policy = buildToolPolicy({ disallowedTools: [" Write "] });
    // The denied pattern is stored trimmed → "Write"
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
  });

  test("Bash deny filter (Bash(rm:*)) does NOT block unrelated tool 'BashHelper'", () => {
    const policy = buildToolPolicy({ disallowedTools: ["Bash(rm:*)"] });
    // BashHelper is not the Bash tool itself
    expect(isToolAllowedByPolicy("BashHelper", policy)).toBe(true);
  });

  test("strict mode blocks unlisted tool even if allowedPatterns is non-empty", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["Read"] },
    });
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
    expect(isToolAllowedByPolicy("Read", policy)).toBe(true);
  });

  test("deny list takes priority over wildcard allow", () => {
    const policy = buildToolPolicy({
      allowedTools: ["*"],
      disallowedTools: ["Write"],
    });
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
    expect(isToolAllowedByPolicy("Read", policy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enforceBashCommandPolicy edge cases
// ---------------------------------------------------------------------------

describe("enforceBashCommandPolicy edge cases", () => {
  test("deny prefix matched case-insensitively on uppercase command", () => {
    const policy: BashCommandPolicy = {
      allowAll: true,
      allowPrefixes: [],
      denyPrefixes: ["rm"],
    };
    expect(() => enforceBashCommandPolicy("RM file.txt", policy)).toThrow(
      "Bash command denied by policy"
    );
  });

  test("allow prefix matched case-insensitively", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["git"],
      denyPrefixes: [],
    };
    // "GIT status" matches allowPrefix "git" (case-insensitive)
    expect(() => enforceBashCommandPolicy("GIT status", policy)).not.toThrow();
  });

  test("command that is a prefix of a deny rule but does not match is allowed", () => {
    const policy: BashCommandPolicy = {
      allowAll: true,
      allowPrefixes: [],
      // "rm " (with space) — "rmdir" does NOT start with "rm "
      denyPrefixes: ["rm "],
    };
    expect(() =>
      enforceBashCommandPolicy("rmdir /tmp/safe", policy)
    ).not.toThrow();
  });

  test("pip install caught by default policy", () => {
    const policy = buildToolPolicy({});
    expect(() =>
      enforceBashCommandPolicy("pip install requests", policy.bashPolicy)
    ).toThrow("Bash command denied by policy");
  });

  test("npm install caught by default policy", () => {
    const policy = buildToolPolicy({});
    expect(() =>
      enforceBashCommandPolicy("npm install lodash", policy.bashPolicy)
    ).toThrow("Bash command denied by policy");
  });

  test("npm run build NOT caught by default policy", () => {
    const policy = buildToolPolicy({});
    // "npm install " and "npm i " are in the deny list — "npm run" is not
    expect(() =>
      enforceBashCommandPolicy("npm run build", policy.bashPolicy)
    ).not.toThrow();
  });
});
