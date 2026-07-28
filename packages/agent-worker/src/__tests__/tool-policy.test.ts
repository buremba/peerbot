import { describe, expect, test } from "bun:test";
import {
  type BashCommandPolicy,
  buildToolPolicy,
  enforceBashCommandPolicy,
  isDirectPackageInstallCommand,
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

  test("backslash-newline is line continuation, not literal text (#2259)", () => {
    // The shell removes backslash-newline before tokenizing, so `r\<nl>m -rf /`
    // executes as `rm -rf /`. Treating the pair as text would let it split a
    // deny prefix in half and slip past the policy.
    const bs = String.fromCharCode(92);
    const policy = {
      allowAll: false,
      allowPrefixes: [] as string[],
      denyPrefixes: ["rm "],
    };
    expect(() =>
      enforceBashCommandPolicy(`r${bs}\nm -rf /tmp/x`, policy)
    ).toThrow("Bash command denied by policy");
    expect(() => enforceBashCommandPolicy("rm -rf /tmp/x", policy)).toThrow(
      "Bash command denied by policy"
    );
    // A continuation inside an allowed command is still harmless.
    expect(() =>
      enforceBashCommandPolicy(`echo ${bs}\nhello`, policy)
    ).not.toThrow();
  });

  test("the matcher is a hint, not a lexer: quoted/escaped/wrapped forms are the sandbox's job (#2259 r8)", () => {
    // These evasions are deliberately NOT caught by the text matcher — matching
    // them means reimplementing bash's lexer and only yields false positives on
    // honest commands. Enforcement is the sandbox binary-discovery filter (see
    // embedded-just-bash-bootstrap.test.ts). Documented as ALLOWED here so the
    // contract is explicit and a future "tighten the regex" change is a
    // conscious decision, not an accident.
    // Each form below is a spelling bash really resolves to the `nix` binary
    // (quote removal runs before the PATH lookup), so every one of them would
    // execute `nix run` if `nix` were discoverable at all.
    const bs = String.fromCharCode(92);
    const policy = buildToolPolicy({}).bashPolicy;
    for (const cmd of [
      "$'nix' run nixpkgs#hello", // ANSI-C quoted name
      `n$'${bs}151'x run nixpkgs#hello`, // name assembled from an octal escape
      `n${bs}ix run nixpkgs#hello`, // backslash-escaped name
      "env nix run nixpkgs#hello", // exec wrapper
      "git commit -m 'nix shell support'", // package phrase as quoted data
    ]) {
      expect(() => enforceBashCommandPolicy(cmd, policy)).not.toThrow();
    }
  });

  // The preflight hint runs on EVERY bash command, so a package-manager phrase
  // appearing inside quoted argument data must not be read as a command. The
  // pattern boundary class deliberately excludes quote characters: only a real
  // shell operator (start, whitespace, `;`, `|`, `&`, parens) opens a command
  // position. Before this, `git commit -m 'apt install docs'` threw DIRECT
  // PACKAGE INSTALL BLOCKED and the new nix entries widened that to the much
  // likelier `nix shell` phrasing.
  test("package phrases inside quoted data are not install commands (#2259)", () => {
    for (const cmd of [
      "git commit -m 'nix shell support'",
      'git commit -m "nix shell support"',
      "git commit -m 'apt install docs'",
      "echo 'pip install foo'",
      "echo 'nix run docs'",
      "grep -r 'uvx' .",
      "nixfmt file.nix",
      // The phrase mid-quote is the same data: the whitespace in front of it
      // is inside the quote and must not open a command position.
      "git commit -m 'document nix shell support'",
      "echo 'use uvx here'",
      "git commit -m 'we should apt install curl'",
      'git commit -m "then run pipx install black"',
      // Text after an unquoted `#` is a comment, never executed. `#` opens one
      // after an operator too, not just after whitespace.
      "echo done # nix run x",
      "ls # uvx cowsay",
      "echo hi;# nix run x",
      "echo hi ;# nix run x",
      // An interpreter named in ARGUMENT position runs nothing; only a real
      // command-position `sh -c` body is a command.
      "echo sh -c 'nix run x'",
      "printf 'sh -c nix run'",
      "git commit -m \"sh -c 'nix run x'\"",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    }
  });

  test("a command-position `sh -c` body IS scanned (#2259)", () => {
    for (const cmd of [
      "bash -c 'nix run x'",
      "sh -lc 'uvx cowsay'",
      "true; bash -c 'nix run x'",
      "(sh -c 'uvx x')",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
  });

  test("a mid-token '#' is not a comment (#2259)", () => {
    // `#` opens a comment only at the start of a word. Mid-token it is data
    // (`nixpkgs#hello`), so a package manager AFTER such a token must still be
    // seen — treating the first `#` as a comment would blank the rest of the
    // line and hide it.
    expect(isDirectPackageInstallCommand("echo nixpkgs#hello; nix run x")).toBe(
      true
    );
    expect(isDirectPackageInstallCommand("nix run nixpkgs#hello")).toBe(true);
    // …while a real comment still hides what follows it.
    expect(isDirectPackageInstallCommand("echo hi # nix run x")).toBe(false);
  });

  test("a real install still trips the hint, including after an operator (#2259)", () => {
    for (const cmd of [
      "nix shell nixpkgs#hello",
      "nix run nixpkgs#hello",
      "nix build .#pkg",
      "nix-shell -p hello",
      "uvx cowsay",
      "pipx run black",
      "pnpm dlx cowsay",
      "uv tool install ruff",
      "apt install curl",
      "sudo nix run x",
      "true; nix run nixpkgs#hello",
      "(nix shell nixpkgs#hello)",
      // An interpreter's `-c` body IS a command position, unlike `-m` data.
      "bash -c 'nix shell nixpkgs#hello'",
      "sh -lc 'uvx cowsay'",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
  });
});
