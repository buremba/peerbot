import { describe, expect, test } from "bun:test";
import {
  type BashCommandPolicy,
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
  normalizeToolList,
} from "../openclaw/tool-policy";

describe("normalizeToolList", () => {
  test("returns empty array for undefined", () => {
    expect(normalizeToolList(undefined)).toEqual([]);
  });

  test("returns empty array for empty string", () => {
    expect(normalizeToolList("")).toEqual([]);
  });

  test("splits comma-separated string", () => {
    expect(normalizeToolList("read,write,edit")).toEqual([
      "read",
      "write",
      "edit",
    ]);
  });

  test("splits newline-separated string", () => {
    expect(normalizeToolList("read\nwrite\nedit")).toEqual([
      "read",
      "write",
      "edit",
    ]);
  });

  test("trims whitespace from entries", () => {
    expect(normalizeToolList(" read , write , edit ")).toEqual([
      "read",
      "write",
      "edit",
    ]);
  });

  test("filters empty entries", () => {
    expect(normalizeToolList("read,,write,,")).toEqual(["read", "write"]);
  });

  test("passes through arrays", () => {
    expect(normalizeToolList(["read", "write"])).toEqual(["read", "write"]);
  });
});

describe("buildToolPolicy", () => {
  test("returns default policy with no inputs", () => {
    const policy = buildToolPolicy({});
    expect(policy.allowedPatterns).toEqual([]);
    expect(policy.deniedPatterns).toEqual([]);
    expect(policy.strictMode).toBe(false);
    expect(policy.bashPolicy.allowAll).toBe(false);
    expect(policy.bashPolicy.allowPrefixes).toEqual([]);
    expect(policy.bashPolicy.denyPrefixes).toContain("apt-get ");
    expect(policy.bashPolicy.denyPrefixes).toContain("nix-shell ");
  });

  test("merges toolsConfig with params", () => {
    const policy = buildToolPolicy({
      toolsConfig: { allowedTools: ["Read"], deniedTools: ["Write"] },
      allowedTools: "Edit",
      disallowedTools: "Bash",
    });
    expect(policy.allowedPatterns).toEqual(["Read", "Edit"]);
    expect(policy.deniedPatterns).toEqual(["Write", "Bash"]);
  });

  test("sets strictMode from toolsConfig", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true },
    });
    expect(policy.strictMode).toBe(true);
  });

  test("extracts Bash allow prefixes", () => {
    const policy = buildToolPolicy({
      allowedTools: ["Bash(npm:*)", "Bash(git:*)"],
    });
    expect(policy.bashPolicy.allowPrefixes).toEqual(["npm", "git"]);
  });

  test("extracts Bash deny prefixes", () => {
    const policy = buildToolPolicy({
      disallowedTools: ["Bash(rm:*)"],
    });
    expect(policy.bashPolicy.denyPrefixes).toContain("rm");
    expect(policy.bashPolicy.denyPrefixes).toContain("apt ");
  });

  test("detects bash allowAll when Bash is in allowed patterns", () => {
    const policy = buildToolPolicy({ allowedTools: ["Bash", "Read"] });
    expect(policy.bashPolicy.allowAll).toBe(true);
  });

  test("wildcard * enables bash allowAll", () => {
    const policy = buildToolPolicy({ allowedTools: ["*"] });
    expect(policy.bashPolicy.allowAll).toBe(true);
  });
});

describe("isToolAllowedByPolicy", () => {
  test("allows all tools in non-strict mode", () => {
    const policy = buildToolPolicy({});
    expect(isToolAllowedByPolicy("Read", policy)).toBe(true);
    expect(isToolAllowedByPolicy("Write", policy)).toBe(true);
    expect(isToolAllowedByPolicy("CustomTool", policy)).toBe(true);
  });

  test("denies explicitly denied tools", () => {
    const policy = buildToolPolicy({ disallowedTools: ["Write"] });
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
    expect(isToolAllowedByPolicy("Read", policy)).toBe(true);
  });

  test("allows bash in non-strict mode even without explicit allow", () => {
    const policy = buildToolPolicy({});
    expect(isToolAllowedByPolicy("Bash", policy)).toBe(true);
  });

  test("blocks bash in strict mode without explicit allow", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true },
    });
    expect(isToolAllowedByPolicy("Bash", policy)).toBe(false);
  });

  test("allows bash in strict mode with explicit allow", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["Bash"] },
    });
    expect(isToolAllowedByPolicy("Bash", policy)).toBe(true);
  });

  test("allows bash in strict mode with command allowlist", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true },
      allowedTools: ["Bash(npm:*)"],
    });
    expect(isToolAllowedByPolicy("Bash", policy)).toBe(true);
  });

  test("blocks non-allowed tools in strict mode", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["Read"] },
    });
    expect(isToolAllowedByPolicy("Read", policy)).toBe(true);
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
  });

  test("wildcard in allowed patterns allows all tools", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["*"] },
    });
    expect(isToolAllowedByPolicy("AnythingGoes", policy)).toBe(true);
  });

  test("case-insensitive tool matching", () => {
    const policy = buildToolPolicy({ disallowedTools: ["write"] });
    expect(isToolAllowedByPolicy("Write", policy)).toBe(false);
    expect(isToolAllowedByPolicy("WRITE", policy)).toBe(false);
  });

  test("Bash filters in deny list do not block non-Bash tool matching", () => {
    // Bash(rm:*) should only affect bash command filtering, not block the Bash tool itself
    const policy = buildToolPolicy({ disallowedTools: ["Bash(rm:*)"] });
    expect(isToolAllowedByPolicy("Bash", policy)).toBe(true);
  });
});

describe("enforceBashCommandPolicy", () => {
  test("allows empty command", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: [],
      denyPrefixes: [],
    };
    expect(() => enforceBashCommandPolicy("", policy)).not.toThrow();
    expect(() => enforceBashCommandPolicy("  ", policy)).not.toThrow();
  });

  test("throws on denied prefix match", () => {
    const policy: BashCommandPolicy = {
      allowAll: true,
      allowPrefixes: [],
      denyPrefixes: ["rm"],
    };
    expect(() => enforceBashCommandPolicy("rm -rf /", policy)).toThrow(
      "Bash command denied by policy"
    );
  });

  test("deny check is case-insensitive", () => {
    const policy: BashCommandPolicy = {
      allowAll: true,
      allowPrefixes: [],
      denyPrefixes: ["rm"],
    };
    expect(() => enforceBashCommandPolicy("RM -rf /", policy)).toThrow(
      "Bash command denied by policy"
    );
  });

  test("package manager commands are blocked", () => {
    const policy = buildToolPolicy({});
    expect(() =>
      enforceBashCommandPolicy("apt-get install -y ffmpeg", policy.bashPolicy)
    ).toThrow("Bash command denied by policy");
  });

  test("allows all when allowAll is true", () => {
    const policy: BashCommandPolicy = {
      allowAll: true,
      allowPrefixes: [],
      denyPrefixes: [],
    };
    expect(() =>
      enforceBashCommandPolicy("any command here", policy)
    ).not.toThrow();
  });

  test("allows when no allow prefixes (no filter)", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: [],
      denyPrefixes: [],
    };
    expect(() =>
      enforceBashCommandPolicy("some command", policy)
    ).not.toThrow();
  });

  test("allows commands matching allow prefixes", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["npm", "git"],
      denyPrefixes: [],
    };
    expect(() => enforceBashCommandPolicy("npm install", policy)).not.toThrow();
    expect(() => enforceBashCommandPolicy("git status", policy)).not.toThrow();
  });

  test("rejects commands not matching allow prefixes", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["npm", "git"],
      denyPrefixes: [],
    };
    expect(() =>
      enforceBashCommandPolicy("curl http://example.com", policy)
    ).toThrow("Bash command not allowed by policy");
  });

  test("deny takes priority over allow", () => {
    const policy: BashCommandPolicy = {
      allowAll: false,
      allowPrefixes: ["rm"],
      denyPrefixes: ["rm"],
    };
    expect(() => enforceBashCommandPolicy("rm file.txt", policy)).toThrow(
      "Bash command denied by policy"
    );
  });
});
