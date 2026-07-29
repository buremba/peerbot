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
      // A newline is a command separator too, so an interpreter on its own
      // line is in command position and its body must be scanned.
      "echo ok\nsh -c 'nix run x'",
      "cd /tmp\nbash -c 'uvx cowsay'",
      // `c` can sit anywhere in a short-option cluster, and options may be
      // separate words. Matching only clusters ending in `c` missed all of
      // these — including the very common `-euo pipefail -c` idiom.
      "bash -ce 'nix run x'",
      "sh -cx 'uvx cowsay'",
      "bash -e -c 'nix run x'",
      "bash -o pipefail -c 'nix run x'",
      "bash -euo pipefail -c 'uvx x'",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
  });

  test("option scanning stays linear on adversarial input (#2259, CodeQL 481)", () => {
    // The command string is agent-controlled, so an ambiguous pattern here is a
    // worker CPU denial of service, not just a slow path. The option loop used
    // to offer `-[a-z]*\s+` and `-[a-z]*\s+\S+\s+` as alternatives; since `\S+`
    // also matches an option, a run of bare `-` words had exponentially many
    // parses and a non-matching tail made the engine try all of them. Measured
    // before the fix: 232ms at 34 repetitions, 1.26s at 38, doubling per pair.
    for (const cmd of [
      `\nsh ${"- ".repeat(2000)}x`,
      `bash ${"-e ".repeat(2000)}nope`,
      `bash ${"-o x ".repeat(1000)}-c 'nix run x'`,
      `bash -c '${"a;".repeat(3000)}'`,
    ]) {
      const started = performance.now();
      isDirectPackageInstallCommand(cmd);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  test("an interpreter named as an argument is still not a command (#2259)", () => {
    // The option-cluster widening must not start matching argument text.
    for (const cmd of [
      "echo bash -ce 'nix run x'",
      "git commit -m 'bash -ce nix run'",
      "bash -x script.sh",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
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

  test("a manager consumed as data by a word before it is not an install (#2279)", () => {
    // Plain whitespace precedes every ARGUMENT, so a command that merely NAMES
    // a manager used to read as an install. #2259 only widened the manager
    // list, which made the latent bug fire on the far commoner `nix`/`uvx`
    // spellings — "nix shell" turns up in commit messages and grep patterns.
    for (const cmd of [
      // The four spellings reported on the issue. The first needs no data word
      // at all — a quoted span is already blanked before matching (#2259).
      "git commit -m 'document nix shell support'",
      "echo uvx cowsay",
      "git log --grep nix run",
      "man nix run",
      // …and the rest of the class, from the probes on #2273 / #2277.
      "echo npm install",
      "echo if npm install",
      "echo x{ npm install",
      "echo iffy nix run",
      "which nix",
      "printf %s pip install",
      "ls -la nix run",
      "git log --oneline --grep 'apt install'",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    }
  });

  test("an argument position this cannot prove still flags (#2279)", () => {
    // The narrowing is one word deep on purpose. A wrapper's own options and
    // operands are NOT modelled — how many words `timeout`/`flock`/`chroot`
    // take before the command they run is per-wrapper knowledge this matcher
    // refuses to encode — so a manager after them keeps firing. Same for a
    // backslash line continuation, which is shell lexing this does not do.
    const bs = String.fromCharCode(92);
    for (const cmd of [
      "timeout --signal KILL 5 npm install left-pad",
      "flock -w 10 /tmp/lock npm install left-pad",
      "chroot --userspec root /jail npm install left-pad",
      `FOO=bar${bs}\nbaz npm install left-pad`,
      `sudo -u ro${bs}\not npm install left-pad`,
      // The full denied list from the issue, so narrowing the false positives
      // cannot silently trade them for a missed install.
      "npm install lodash",
      "FOO=bar npm install lodash",
      "time npm install lodash",
      "true; npm install lodash",
      "true && uvx cowsay",
      "(nix shell nixpkgs#hello)",
      "if nix run x; then :; fi",
      "{ nix run x; }",
      "! nix run x",
      "for i in 1; do nix run x; done",
      "bash -c 'nix run x'",
      "bash -euo pipefail -c 'uvx x'",
      // A data word swallows its OWN command, not the rest of the pipeline…
      "echo uvx cowsay | npm install left-pad",
      // …and only what comes after it.
      "npm install echo",
      // A SHORT option is never a data word: one letter means different things
      // to different commands, and `parallel -m` is max-args, not a message —
      // it runs the very install a `-m` entry would have hidden.
      "parallel -m npm install lodash ::: left-pad",
      "parallel -m nix run ::: nixpkgs#hello",
      "git commit -m nix shell support",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
  });

  test("a data word is only data in command position (#2279)", () => {
    // A printer/lookup name narrows ONLY as the word being run. Anywhere else
    // it is an operand of whatever precedes it — a username, a path, a file —
    // and dropping the tail there would silence a real install. Every case
    // below has a data word (`ls`, `type`, `grep`) sitting in an operand slot.
    for (const cmd of [
      "sudo -u ls npm install evil",
      "flock ls npm install evil",
      "timeout --foreground -k ls 5 npm install evil",
      "xargs -a ls npm install evil",
      "git -C ls exec npm install evil",
      "env -u type npm install evil",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
    // Not in this class: a payload living entirely inside quotes is dropped by
    // the #2259 quote blanking before any narrowing runs, so it reads false on
    // origin/main too. Pinned so it is not mistaken for a regression here.
    expect(
      isDirectPackageInstallCommand(
        'docker run --entrypoint sh grep -c "npm install evil"'
      )
    ).toBe(false);
    // …and in command position it still narrows, which is the whole point.
    for (const cmd of ["ls npm install", "grep npm install file", "type npm"]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    }
  });

  test("an escaped separator does not open a command position (#2279)", () => {
    const bs = String.fromCharCode(92);
    // `\;` and `\|` are literal data, so each of these is ONE echo command with
    // the manager as its operand. Splitting on the escaped operator would hand
    // the half after it a command position it does not have.
    expect(isDirectPackageInstallCommand(`echo foo${bs}; nix run x`)).toBe(
      false
    );
    expect(isDirectPackageInstallCommand(`echo foo${bs}| npm install x`)).toBe(
      false
    );
    // An escaped quote is not a quote either, so the real command after it is
    // still scanned instead of being blanked as the body of a quoted span.
    expect(
      isDirectPackageInstallCommand(`echo it${bs}'s fine; npm install lodash`)
    ).toBe(true);
    // An UNescaped separator still opens a command position.
    expect(isDirectPackageInstallCommand("echo foo; nix run x")).toBe(true);
  });

  test("an assignment prefix does not hide the command word (#2279)", () => {
    // `FOO=bar echo …` RUNS echo, so the data word holds command position even
    // though it is not the first word of the command.
    expect(isDirectPackageInstallCommand("FOO=bar echo npm install")).toBe(
      false
    );
    expect(isDirectPackageInstallCommand("FOO=bar BAZ=qux man nix run")).toBe(
      false
    );
    // …while an assignment in front of the manager itself still flags, and a
    // first word that is not an assignment keeps command position for itself —
    // `ls` there is a username, not a printer.
    expect(isDirectPackageInstallCommand("FOO=bar npm install lodash")).toBe(
      true
    );
    expect(isDirectPackageInstallCommand("sudo -u ls npm install evil")).toBe(
      true
    );
    // A QUOTED or escaped value must keep the assignment one word. Blanking the
    // span leaves `foo="` plus a lone `"`, and treating that stray quote as the
    // command word used to push `echo` out of command position.
    const bs = String.fromCharCode(92);
    expect(isDirectPackageInstallCommand('FOO="bar" echo npm install')).toBe(
      false
    );
    expect(isDirectPackageInstallCommand("FOO='bar' man nix run")).toBe(false);
    // An ESCAPED space inside the value is NOT covered: blanking the escape
    // pair splits `FOO=ba\ r` into `FOO=ba` and `r`, so `r` takes command
    // position and `echo` stops narrowing. Pinned as a known over-denial — the
    // safe direction — rather than chased, since un-splitting it means lexing
    // escapes properly, which is the bash-reimplementation this file refuses.
    expect(
      isDirectPackageInstallCommand(`FOO=ba${bs} r echo npm install`)
    ).toBe(true);
    // …and it must not swallow a real install hiding behind the same shape.
    expect(isDirectPackageInstallCommand('FOO="bar" npm install lodash')).toBe(
      true
    );
  });

  test("a pattern option is only data for the command that owns it (#2279)", () => {
    // An option is not self-evidently an option. `env -u NAME` takes a VARIABLE
    // NAME and then execs the rest, so `--grep` there is an operand — honouring
    // it anywhere hid a real install behind any exec wrapper taking a value.
    for (const cmd of [
      "env -u --grep npm install evil",
      "env -u --regexp npm install evil",
      "sudo -u --grep npm install evil",
      "timeout --signal --grep 5 npm install evil",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(true);
    }
    // Owned by the command that spells it, so it still narrows.
    for (const cmd of [
      "git log --grep nix run",
      "grep --regexp nix run file",
      "rg --regexp uvx cowsay",
    ]) {
      expect(isDirectPackageInstallCommand(cmd)).toBe(false);
    }
  });

  test("an interpreter body gets the same narrowing (#2279)", () => {
    // The `-c` body is scanned separately, so it needs its own coverage: a
    // manager merely echoed inside the body is not an install…
    expect(isDirectPackageInstallCommand('bash -c "echo npm install"')).toBe(
      false
    );
    // …while one actually run inside the body still is.
    expect(isDirectPackageInstallCommand('bash -c "npm install evil"')).toBe(
      true
    );
    expect(
      isDirectPackageInstallCommand('sh -c "sudo -u ls npm install"')
    ).toBe(true);
  });
});
