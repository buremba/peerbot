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
} from "../openclaw/tool-policy";

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
