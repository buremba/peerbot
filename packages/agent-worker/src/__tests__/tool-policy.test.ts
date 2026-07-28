import { describe, expect, test } from "bun:test";
import {
  type BashCommandPolicy,
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
  normalizeToolList,
} from "../runtime/tool-policy";

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

  test("new-style nix CLI and store helpers are denied (#2259)", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "nix run nixpkgs#hello",
      "nix shell nixpkgs#git -c git push",
      "nix develop",
      "nix build .#pkg",
      "nix-store --realise /nix/store/abc",
      "nix-channel --update",
      "git status && nix run nixpkgs#hello",
      "sudo nix run nixpkgs#hello",
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).toThrow(
        "Bash command denied by policy"
      );
    }
  });

  test("ad-hoc package runners are denied (#2259)", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "uvx cowsay moo",
      "uv tool install ruff",
      "true && pipx run cowsay",
      "pnpm dlx create-react-app x",
      "yarn dlx create-react-app x",
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).toThrow(
        "Bash command denied by policy"
      );
    }
  });

  test("nix-adjacent and runner-adjacent commands stay allowed (#2259)", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "nixfmt flake.nix",
      "npx eslint .",
      "uv run script.py",
      "uv tool list",
      "yarn run dlx-helper",
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).not.toThrow();
    }
  });

  test("an escaped shell operator is data, not a command boundary (#2259 r8)", () => {
    // `echo foo\; nix run x` is ONE echo with a literal `;`; bash never runs
    // `nix run`. The splitter must not treat the escaped `;` as a boundary.
    const bs = String.fromCharCode(92);
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      `echo foo${bs}; nix run x`,
      `echo a ${bs}| nix run x`,
      `echo a ${bs}& nix run x`,
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).not.toThrow();
    }
    // An UNescaped operator still splits and denies the second command.
    expect(() =>
      enforceBashCommandPolicy("echo foo; nix run x", policy)
    ).toThrow("Bash command denied by policy");
  });

  test("the matcher is a hint, not a lexer: quoted/escaped/wrapped forms are the sandbox's job (#2259 r8)", () => {
    // These evasions are deliberately NOT caught by the text matcher — matching
    // them means reimplementing bash's lexer and only yields false positives on
    // honest commands. Enforcement is the sandbox binary-discovery filter (see
    // embedded-just-bash-bootstrap.test.ts). Documented as ALLOWED here so the
    // contract is explicit and a future "tighten the regex" change is a
    // conscious decision, not an accident.
    const bs = String.fromCharCode(92);
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      `"n${bs}ix"`, // escaped name inside quotes
      `$'nix${bs}x20run'`, // ANSI-C quoting
      "env nix run nixpkgs#hello", // exec wrapper
      "git commit -m 'nix shell support'", // package phrase as quoted data
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).not.toThrow();
    }
  });
});
