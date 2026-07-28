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
    expect(policy.bashPolicy.denyPrefixes).toContain("nix ");
    expect(policy.bashPolicy.denyPrefixes).toContain("nix-store ");
    expect(policy.bashPolicy.denyPrefixes).toContain("uvx ");
    expect(policy.bashPolicy.denyPrefixes).toContain("pnpm dlx ");
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

  test("nix commands and store helpers are blocked by default prefixes", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    expect(() =>
      enforceBashCommandPolicy("nix shell nixpkgs#git -c git push", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("git status && nix run nixpkgs#hello", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("nix-store --realise /nix/store/abc", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy(
        "nix-copy-closure --from host /nix/store/abc",
        policy
      )
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("sudo nix shell nixpkgs#git", policy)
    ).toThrow("Bash command denied by policy");
  });

  test("ad-hoc package runners are blocked by default prefixes", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    expect(() => enforceBashCommandPolicy("uvx cowsay moo", policy)).toThrow(
      "Bash command denied by policy"
    );
    expect(() =>
      enforceBashCommandPolicy("true && pipx run cowsay", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("yarn dlx create-react-app x", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("uv tool upgrade ruff", policy)
    ).toThrow("Bash command denied by policy");
    expect(() =>
      enforceBashCommandPolicy("uv tool list", policy)
    ).not.toThrow();
  });

  test("quoted nix words are data, not commands, at the segment layer", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    expect(() =>
      enforceBashCommandPolicy('echo "nix shell"', policy)
    ).not.toThrow();
    expect(() =>
      enforceBashCommandPolicy("git commit -m 'nix support'", policy)
    ).not.toThrow();
  });

  test("exec wrappers around a denied command are peeled and denied", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "env nix run nixpkgs#hello",
      "sudo env nix shell nixpkgs#git",
      "timeout 5s nix run nixpkgs#hello",
      "timeout 5 uvx cowsay",
      "nice -n 10 npm install lodash",
      "nohup pnpm dlx create-react-app y",
      "env FOO=bar nix run nixpkgs#hello",
      "command env nix run nixpkgs#hello",
      "/usr/bin/env nix run nixpkgs#hello",
      "setsid uvx cowsay",
      "xargs npm install",
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).toThrow(
        "Bash command denied by policy"
      );
    }
  });

  test("a wrapper flag's separate operand cannot shift the command out of range", () => {
    // `-u`/`-C`/`-s` take their value as a SEPARATE word, which the flag peel
    // leaves at the head of the remainder (`env -u PATH nix run …` → `path
    // nix run …`). A prefix-only check on that remainder misses the install,
    // so the remainder is matched at every token boundary instead. (#2259 r6.)
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "env -u PATH nix run nixpkgs#hello",
      "env -C /tmp nix run nixpkgs#hello",
      "sudo -u nobody nix shell nixpkgs#git",
      "timeout -s KILL 5 nix run nixpkgs#hello",
      "env -i -u HOME LC_ALL=C uvx cowsay",
      "xargs -a list.txt -I{} npm install",
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).toThrow(
        "Bash command denied by policy"
      );
    }
  });

  test("wrapper word as plain data does not spuriously deny", () => {
    const policy = buildToolPolicy({}).bashPolicy;
    expect(() =>
      enforceBashCommandPolicy('echo "run env nix later"', policy)
    ).not.toThrow();
    expect(() =>
      enforceBashCommandPolicy("git commit -m 'add env config'", policy)
    ).not.toThrow();
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
