import type { ToolsConfig } from "@lobu/core";

export type BashCommandPolicy = {
  allowAll: boolean;
  allowPrefixes: string[];
  denyPrefixes: string[];
};

type ToolPolicy = {
  toolsConfig?: ToolsConfig;
  allowedPatterns: string[];
  deniedPatterns: string[];
  strictMode: boolean;
  bashPolicy: BashCommandPolicy;
};

const DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES = [
  "apt ",
  "apt-get ",
  "yum ",
  "dnf ",
  "apk ",
  "pacman ",
  "zypper ",
  "brew ",
  "nix-shell ",
  "nix-env ",
  // New-style nix CLI. `nix shell`/`nix run`/`nix develop` put arbitrary
  // packages on PATH or fetch-and-execute them, and `nix build`/`nix-store`
  // realise arbitrary derivations — the same capability the old-style commands
  // above already denied. A bare `nix ` prefix covers every subcommand
  // (conservative, like `brew `); `nixfmt` and friends are unaffected because
  // the prefix requires the trailing space.
  "nix ",
  "nix-build ",
  "nix-store ",
  "nix-channel ",
  "nix-instantiate ",
  "nix-prefetch-url ",
  "nix-collect-garbage ",
  "nix-copy-closure ",
  // Direct tool/dependency mutations and one-shot package runners.
  // `npx`/`bunx` are deliberately absent — they prefer already-installed local
  // binaries and denying them breaks legitimate repo workflows.
  "uvx ",
  "uv tool install ",
  "uv tool run ",
  "uv tool upgrade ",
  "uv add ",
  "pipx install ",
  "pipx run ",
  "pipx upgrade ",
  "pipx upgrade-all ",
  "pipx inject ",
  "pipx reinstall ",
  "pipx reinstall-all ",
  "pipx runpip ",
  "pnpm dlx ",
  "yarn dlx ",
  "sudo apt ",
  "sudo apt-get ",
  "sudo yum ",
  "sudo dnf ",
  "sudo apk ",
  "sudo pacman ",
  "sudo zypper ",
  "sudo brew ",
  "sudo nix-shell ",
  "sudo nix-env ",
  "sudo nix ",
  "sudo nix-build ",
  "sudo nix-store ",
  "sudo nix-channel ",
  "sudo nix-instantiate ",
  "sudo nix-prefetch-url ",
  "sudo nix-collect-garbage ",
  "sudo nix-copy-closure ",
  "pip install ",
  "pip3 install ",
  "uv pip install ",
  "npm install ",
  "npm i ",
  "pnpm install ",
  "pnpm add ",
  "yarn install ",
  "yarn add ",
  "bun install ",
  "bun add ",
  "cargo install ",
  "go install ",
  "gem install ",
  "poetry add ",
  "composer require ",
];

const DIRECT_PACKAGE_INSTALL_PATTERNS = [
  /(^|[\s"'`;|&()])(?:sudo\s+)?(?:apt|apt-get|yum|dnf|apk|pacman|zypper|brew)\s+(?:install|upgrade|add)\b/i,
  /(^|[\s"'`;|&()])(?:sudo\s+)?(?:[^\s"'`;|&()]+\/)?(?:nix-shell|nix-env)\b/i,
  // High-risk new-style commands are recognized even through a shell wrapper
  // or path-qualified binary. Leading `nix` invocations are denied wholesale
  // by the prefix list above.
  /(^|[\s"'`;|&()])(?:sudo\s+)?(?:[^\s"'`;|&()]+\/)?nix\s+(?:profile|shell|run|develop|build|eval|flake|store|copy|bundle|repl|search|fmt|edit|print-dev-env|why-depends|derivation|realisation|registry|upgrade-nix)\b/i,
  /(^|[\s"'`;|&()])(?:sudo\s+)?(?:[^\s"'`;|&()]+\/)?nix\s+-/i,
  /(^|[\s"'`;|&()])(?:sudo\s+)?(?:[^\s"'`;|&()]+\/)?nix-(?:build|store|channel|instantiate|prefetch-url|collect-garbage|copy-closure)\b/i,
  /(^|[\s"'`;|&()])(?:pip|pip3)\s+install\b/i,
  // Direct dependency/tool acquisition is denied. `uv run` remains allowed,
  // like cargo/go builds, even though it may sync a declared project env.
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?uv\s+pip\s+install\b/i,
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?uv\s+(?:tool\s+(?:install|run|upgrade)|add)\b/i,
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?uvx\b/i,
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?pipx\s+(?:install|run|upgrade|upgrade-all|inject|reinstall|reinstall-all|runpip)\b/i,
  /(^|[\s"'`;|&()])npm\s+(?:install|i)\b/i,
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?pnpm\s+(?:install|add|dlx)\b/i,
  /(^|[\s"'`;|&()])(?:[^\s"'`;|&()]+\/)?yarn\s+(?:install|add|global\s+add|dlx)\b/i,
  /(^|[\s"'`;|&()])bun\s+(?:install|add)\b/i,
  /(^|[\s"'`;|&()])cargo\s+install\b/i,
  /(^|[\s"'`;|&()])go\s+install\b/i,
  /(^|[\s"'`;|&()])gem\s+install\b/i,
  /(^|[\s"'`;|&()])poetry\s+add\b/i,
  /(^|[\s"'`;|&()])composer\s+require\b/i,
];

/** Single-character ANSI-C (`$'…'`) escapes, per the bash manual. */
const ANSI_C_SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/**
 * Numeric ANSI-C escape shapes: `\nnn` octal, `\xHH` hex, `\uHHHH` and
 * `\UHHHHHHHH` unicode.
 */
function ansiCNumericEscape(
  lead: string,
  at: number
): { radix: number; maxDigits: number; from: number } | null {
  if (lead === "x") return { radix: 16, maxDigits: 2, from: at + 1 };
  if (lead === "u") return { radix: 16, maxDigits: 4, from: at + 1 };
  if (lead === "U") return { radix: 16, maxDigits: 8, from: at + 1 };
  // Octal has no introducer letter, so the digit itself is the first digit.
  if (lead >= "0" && lead <= "7") return { radix: 8, maxDigits: 3, from: at };
  return null;
}

/**
 * Decode one ANSI-C escape sequence, where `at` indexes the character AFTER the
 * backslash. Returns the character bash would produce and the index just past
 * the sequence.
 *
 * This is the difference between text and execution: inside `$'…'` bash decodes
 * `\x69` / `\151` to `i`, so `$'n\x69x' run …` runs `nix`. Collapsing the
 * escape to its literal characters (`nx69x`) is not a conservative over-match,
 * it is a MISS — the deny rules never see the real executable name.
 *
 * An unrecognized escape keeps its backslash, exactly as bash does.
 */
function decodeAnsiCEscape(
  segment: string,
  at: number
): { text: string; next: number } {
  const lead = segment[at] ?? "";
  const simple = ANSI_C_SIMPLE_ESCAPES[lead];
  if (simple !== undefined) {
    return { text: simple, next: at + 1 };
  }
  const numeric = ansiCNumericEscape(lead, at);
  if (numeric) {
    const isDigit = (c: string): boolean =>
      numeric.radix === 8 ? c >= "0" && c <= "7" : /^[0-9a-f]$/i.test(c);
    let end = numeric.from;
    while (
      end < segment.length &&
      end - numeric.from < numeric.maxDigits &&
      isDigit(segment[end] ?? "")
    ) {
      end++;
    }
    const digits = segment.slice(numeric.from, end);
    const value = Number.parseInt(digits, numeric.radix);
    // No digits at all (`$'\x'`) or an out-of-range code point: bash emits the
    // sequence literally, so keep it rather than throwing.
    if (end > numeric.from && Number.isFinite(value) && value <= 0x10ffff) {
      return { text: String.fromCodePoint(value), next: end };
    }
  }
  // `\cX` — the control character for X.
  if (lead === "c" && at + 1 < segment.length) {
    return {
      text: String.fromCharCode(segment.charCodeAt(at + 1) & 0x1f),
      next: at + 2,
    };
  }
  return { text: `\\${lead}`, next: at + 1 };
}

/**
 * Canonicalize a shell segment to the token string the shell would actually
 * execute: remove quote DELIMITERS while joining the fragments they wrap (so
 * `"nix"` → `nix`, `n"i"x` → `nix`, `n'i'x` → `nix`, `$'nix'` → `nix`), decode
 * ANSI-C escapes inside `$'…'` (`$'n\x69x'` → `nix`, `n$'\151'x` → `nix`), and
 * drop plain backslash escapes (`n\ix` → `nix`). The detector matches against
 * this canonical form so an honestly-typed package manager is recognized
 * however it is spelled.
 *
 * `dataStripped` additionally removes the CONTENTS of quoted spans, for a
 * segment whose leading command treats its quoted arguments as data (`echo`,
 * `cat`) — so a package name inside an echoed string is not a false positive.
 */
function canonicalizeSegment(segment: string): {
  code: string;
  dataStripped: string;
} {
  let code = "";
  let dataStripped = "";
  let quote: '"' | "'" | null = null;
  // Whether the open span is ANSI-C quoting (`$'…'`), whose body bash decodes.
  let ansiC = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\" && i + 1 < segment.length) {
      if (ansiC) {
        const decoded = decodeAnsiCEscape(segment, i + 1);
        code += decoded.text;
        // The loop's own `i++` advances onto the first unconsumed character.
        i = decoded.next - 1;
        continue;
      }
      code += segment[i + 1];
      if (!quote) {
        dataStripped += segment[i + 1];
      }
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        ansiC = false;
      } else {
        code += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // ANSI-C (`$'nix'`) and locale (`$"nix"`) quoting: bash drops the `$` along
    // with the quotes, so `$'nix' run x` executes `nix`. The sigil is part of
    // the delimiter and must not survive into the canonical form, or it would
    // sit in front of the executable name and defeat both the deny-prefix
    // `startsWith` and the regex word boundaries.
    const next = segment[i + 1];
    if (ch === "$" && (next === '"' || next === "'")) {
      quote = next;
      // Only `$'…'` decodes escapes; `$"…"` is locale translation, whose body
      // follows double-quote rules and is handled by the generic branch above.
      ansiC = next === "'";
      i++;
      continue;
    }
    code += ch;
    dataStripped += ch;
  }
  return {
    code: code.trim().toLowerCase(),
    dataStripped: dataStripped.trim().toLowerCase(),
  };
}

/**
 * Leading commands whose quoted arguments are purely passive DATA. For a
 * segment led by one of these, the quoted content is dropped before matching so
 * an echoed / concatenated package-manager phrase is not a false positive.
 * Deliberately NARROW: only commands that cannot execute a string argument.
 * Anything that can run code from an argument (`sh`/`bash`/`eval`, `git -c
 * alias=!…`, `rg --pre`, `awk`, `find -exec`, an unknown binary) is NOT here,
 * so its quoted content is still matched. A word missing from this list can
 * only cost a false positive on the advisory hint, never weaken enforcement —
 * see the header note on {@link isDirectPackageInstallCommand}.
 */
const QUOTED_ARG_IS_DATA_COMMANDS = new Set<string>([
  "echo",
  "printf",
  "print",
  "cat",
  "test",
  "[",
  "head",
  "tail",
  "wc",
]);

/** The leading executable token of a canonical segment, path-stripped. */
function leadingCommand(canonicalCode: string): string {
  const firstWord = canonicalCode.split(/\s+/)[0] ?? "";
  return firstWord.split("/").pop() ?? "";
}

/**
 * Exec wrappers that run their trailing argument as a new command with the
 * caller's PATH. `env nix run …`, `sudo nix …`, `timeout 5 nix …`,
 * `xargs nix …` all invoke `nix` even though the segment's leading token is the
 * wrapper, not `nix`. To keep the deny check from being trivially side-stepped
 * by prepending a wrapper, we peel any run of these wrappers (and their own
 * flags / `env` VAR=val assignments) off the front of a canonical segment
 * before matching, so the check sees the wrapped command. This is the general
 * form of the `sudo …` entries the deny list already enumerated.
 *
 * Deliberately scoped to wrappers whose semantics are "exec argv as a command":
 * an interpreter (`sh -c`) is NOT here — its argument is a script string, not an
 * argv, and is handled by the segment/quote layer instead.
 */
const EXEC_WRAPPERS = new Set<string>([
  "sudo",
  "env",
  "command",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "xargs",
  "time",
  "chrt",
  "taskset",
]);

/**
 * Short options that take a SEPARATE-WORD value for each exec wrapper (`env -u
 * PATH`, `sudo -u nobody`, `timeout -s KILL`, `xargs -I {}`). The value must be
 * consumed with its flag, or it would sit in front of the wrapped command and
 * hide it (`env -u PATH nix run` → the peel must land on `nix`, not `PATH`).
 * `--flag=value` needs no entry (its value is attached). Only options that can
 * realistically precede a wrapped command are listed; a missing one costs at
 * most a false-negative on an exotic invocation, backstopped by the sandbox
 * discovery filter.
 *
 * Entries are lowercased because the canonical segment is lowercased before
 * matching (`env -C /tmp` → `env -c /tmp`). Case-distinct GNU flags (`-C`/`-c`)
 * therefore collapse; consuming a value for either spelling is safe here — the
 * worst case is over-consuming one token, which only risks a false-negative
 * that the sandbox discovery filter still catches.
 */
const EXEC_WRAPPER_OPTIONS_WITH_VALUES: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-c"]),
  env: new Set(["-u", "-c", "-s"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p", "-u"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k"]),
  xargs: new Set(["-i", "-l", "-n", "-p", "-s", "-e", "-d", "-a"]),
  time: new Set(["-f", "-o"]),
  chrt: new Set(["-t", "-p"]),
};

/**
 * Number of REQUIRED positional operands a wrapper consumes before the command
 * (`timeout 5s cmd`, `chrt 1 cmd`, `taskset 0x1 cmd`). Options are handled by
 * {@link EXEC_WRAPPER_OPTIONS_WITH_VALUES}; these are the bare positionals.
 */
const EXEC_WRAPPER_POSITIONAL_VALUES: Record<string, number> = {
  timeout: 1,
  chrt: 1,
  taskset: 1,
};

/**
 * Strip leading exec-wrapper tokens from a canonical segment so the deny/advisory
 * match sees the command the wrapper will actually run. Peels wrapper words,
 * their options (including a separate-word flag value per
 * {@link EXEC_WRAPPER_OPTIONS_WITH_VALUES} and required positionals per
 * {@link EXEC_WRAPPER_POSITIONAL_VALUES}), and `VAR=value` assignments. Stops at
 * the first token that is none of those — that token is the resolved command
 * head. Bounded so a pathological input can't loop.
 *
 * Returns `null` when nothing was peeled, so a caller can tell a genuinely
 * wrapped command from a plain one and match only at the resolved head rather
 * than treating an unwrapped command's arguments as candidate commands.
 */
function stripExecWrappers(canonicalCode: string): string | null {
  const tokens = canonicalCode.split(/\s+/).filter(Boolean);
  let i = 0;
  let peeledWrapper = false;
  // Cap iterations at token count; each pass consumes at least one token.
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    const bare = (token.split("/").pop() ?? "").toLowerCase();
    if (EXEC_WRAPPERS.has(bare)) {
      peeledWrapper = true;
      i++;
      // Consume this wrapper's own options. A separate-word flag value
      // (`env -u PATH`, `sudo -u nobody`, `timeout -s KILL`, `xargs -I {}`) must
      // be consumed with its flag, or that value would sit in front of the
      // wrapped command and hide it. `--flag=value` carries its own value.
      // `--` ends option parsing. Anything else is the command head.
      const optionsWithValues = EXEC_WRAPPER_OPTIONS_WITH_VALUES[bare];
      while (i < tokens.length) {
        const t = tokens[i] ?? "";
        if (t === "--") {
          i++;
          break;
        }
        if (!t.startsWith("-") || t === "-") {
          break;
        }
        const equals = t.indexOf("=");
        const option = equals === -1 ? t : t.slice(0, equals);
        i++;
        if (equals === -1 && optionsWithValues?.has(option)) {
          i++; // consume the separate-word value
        }
      }
      // A few wrappers take REQUIRED positional operands before the command
      // (`timeout 5s cmd`, `chrt 1 cmd`, `taskset 0x1 cmd`).
      const positional = EXEC_WRAPPER_POSITIONAL_VALUES[bare] ?? 0;
      for (let n = 0; n < positional && i < tokens.length; n++) {
        i++;
      }
      continue;
    }
    // `VAR=value` assignment prefix (env-style or shell-style) — skip it.
    if (/^[a-z_][a-z0-9_]*=/i.test(token)) {
      peeledWrapper = true;
      i++;
      continue;
    }
    break;
  }
  if (!peeledWrapper) {
    return null;
  }
  return tokens.slice(i).join(" ");
}

/**
 * Detector for a package-manager install/acquire command, used to return a
 * helpful "declare it in nixPackages instead" message (see
 * {@link enforceBashPreflight}). It canonicalizes shell quoting/escaping and
 * peels leading exec wrappers, so `"nix" run`, `n\ix run`, and `env nix run`
 * are all recognized alongside a bare `nix run`.
 *
 * It is a text-layer gate, not the last line of defense: an interpreter script
 * body (`sh -c '…'`, `awk 'BEGIN{system(…)}'`) can still name a package manager
 * that this pass does not decompose. Those are backstopped by the sandbox
 * binary-discovery filter (`UNSANDBOXED_INTERPRETERS` in
 * `just-bash-bootstrap.ts`): a package manager that is not registered as a
 * runnable command resolves to "command not found" (exit 127) no matter how it
 * is spelled or wrapped, because the lookup is on the RESOLVED binary name,
 * which quoting cannot change. This detector closes the common typed/wrapped
 * cases; the sandbox filter closes the rest.
 */
export function isDirectPackageInstallCommand(command: string): boolean {
  if (!command.trim()) {
    return false;
  }

  const segments = splitShellCommands(command);
  const candidates = segments.length > 0 ? segments : [command];

  return candidates.some((segment) => {
    const { code, dataStripped } = canonicalizeSegment(segment);
    if (!code) {
      return false;
    }
    // Drop quoted content only for a leading command whose quoted args are
    // purely passive data (`echo`, `cat`); otherwise match the full canonical
    // command. Enforcement does not depend on getting this right — the sandbox
    // binary filter blocks the resolved binary regardless (see the header).
    const base = QUOTED_ARG_IS_DATA_COMMANDS.has(leadingCommand(code))
      ? dataStripped
      : code;
    if (!base) {
      return false;
    }
    // Match on the raw canonical form first, then on the exec-wrapper-peeled
    // remainder (`env nix run` → `nix run`, `env -u PATH nix run` → `nix run`)
    // so a wrapped install produces the "declare it in nixPackages" hint
    // instead of silently missing. The wrapper peel resolves the command head
    // past flag operands, so the head-based match sees the real command.
    if (
      DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
        matchesDenyPrefixAtCommandHead(base, prefix)
      ) ||
      DIRECT_PACKAGE_INSTALL_PATTERNS.some((pattern) => pattern.test(base))
    ) {
      return true;
    }
    const wrapped = stripExecWrappers(base);
    if (wrapped === null) {
      return false;
    }
    return (
      DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
        matchesDenyPrefixAtCommandHead(wrapped, prefix)
      ) ||
      DIRECT_PACKAGE_INSTALL_PATTERNS.some((pattern) => pattern.test(wrapped))
    );
  });
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeToolList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  const rawList = Array.isArray(value) ? value : value.split(/[,\n]/);
  return rawList
    .map((entry) =>
      typeof entry === "string" ? entry.trim() : String(entry).trim()
    )
    .filter((entry) => entry.length > 0);
}

function parseBashFilter(pattern: string): string | null {
  const match = pattern.match(/^Bash\(([^:]+):\*\)$/i);
  const prefix = match?.[1]?.trim();
  return prefix || null;
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  const normalizedTool = normalizeToolName(toolName);
  const normalizedPattern = pattern.trim();
  const normalizedPatternLower = normalizedPattern.toLowerCase();

  if (normalizedPattern === "*") {
    return true;
  }

  if (normalizedPatternLower.endsWith("*")) {
    const prefix = normalizedPatternLower.slice(0, -1);
    return normalizedTool.startsWith(prefix);
  }

  return normalizedTool === normalizedPatternLower;
}

export function buildToolPolicy(params: {
  toolsConfig?: ToolsConfig;
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
}): ToolPolicy {
  const allowedPatterns = normalizeToolList(params.allowedTools);
  const deniedPatterns = normalizeToolList(params.disallowedTools);
  const toolsConfig = params.toolsConfig;
  const strictMode = toolsConfig?.strictMode === true;

  const mergedAllowed = [
    ...(toolsConfig?.allowedTools ?? []),
    ...allowedPatterns,
  ].map((p) => p.trim());
  const mergedDenied = [
    ...(toolsConfig?.deniedTools ?? []),
    ...deniedPatterns,
  ].map((p) => p.trim());

  const bashAllowPrefixes = mergedAllowed
    .map((pattern) => parseBashFilter(pattern))
    .filter((prefix): prefix is string => Boolean(prefix));

  const bashDenyPrefixes = mergedDenied
    .map((pattern) => parseBashFilter(pattern))
    .filter((prefix): prefix is string => Boolean(prefix));

  const bashAllowAll = mergedAllowed.some((pattern) =>
    matchesToolPattern("bash", pattern)
  );

  return {
    toolsConfig,
    allowedPatterns: mergedAllowed,
    deniedPatterns: mergedDenied,
    strictMode,
    bashPolicy: {
      allowAll: bashAllowAll,
      allowPrefixes: bashAllowPrefixes,
      denyPrefixes: [
        ...DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES,
        ...bashDenyPrefixes,
      ],
    },
  };
}

export function isToolAllowedByPolicy(
  toolName: string,
  policy: ToolPolicy
): boolean {
  const normalizedName = normalizeToolName(toolName);
  const { allowedPatterns, deniedPatterns, strictMode } = policy;

  const explicitDenied = deniedPatterns.some(
    (pattern) =>
      !parseBashFilter(pattern) && matchesToolPattern(normalizedName, pattern)
  );
  if (explicitDenied) {
    return false;
  }

  if (normalizedName === "bash") {
    if (strictMode) {
      const explicitlyAllowed = allowedPatterns.some((pattern) =>
        matchesToolPattern(normalizedName, pattern)
      );
      const hasCommandAllowlist = policy.bashPolicy.allowPrefixes.length > 0;
      return explicitlyAllowed || hasCommandAllowlist;
    }
    return true;
  }

  if (!strictMode) {
    return true;
  }

  return allowedPatterns.some((pattern) =>
    matchesToolPattern(normalizedName, pattern)
  );
}

/**
 * Split a shell command into its individual sub-commands.
 *
 * A prefix-only allow/deny check is trivially bypassed by command chaining and
 * substitution: an allowed prefix (`git status`) followed by `;`, `&&`, `||`,
 * `|`, a newline, `$( … )`, or backticks runs an arbitrary second command that
 * the policy never inspects. To close that hole we evaluate the prefix check
 * against EVERY sub-command, not just the leading one.
 *
 * This is a deliberately conservative lexer — not a full shell parser. It walks
 * the string tracking single/double quotes and treats any of the shell control
 * operators, plus the boundaries of `$( … )` / backtick substitutions, as
 * segment separators. Substitution boundaries are split rather than recursed so
 * the substituted command body is checked as its own segment. Quoted operators
 * (e.g. `echo "a; b"`) are intentionally left intact — they are data, not a new
 * command — while unquoted ones start a new segment.
 */
function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (inSingle) {
      // Quote delimiters are RETAINED in the segment so downstream consumers can
      // still see quoting (the package-install detector distinguishes quoted
      // data from quoted code). Prefix/allow checks key on the leading command
      // word, which quoting the delimiter never changes.
      current += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      // Inside double quotes only `$( … )` / backticks introduce a new command;
      // everything else (including `;`, `&&`, `|`) is literal data.
      if (ch === '"') {
        inDouble = false;
        current += ch;
      } else if (ch === "$" && next === "(") {
        push();
        i++; // consume "("
      } else if (ch === "`") {
        push();
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }

    // Command-substitution boundaries become segment separators so the
    // substituted body is checked on its own.
    if (ch === "$" && next === "(") {
      push();
      i++; // consume "("
      continue;
    }
    // Process substitution: `<( … )` / `>( … )` runs the inner command, so the
    // boundary starts a new segment and the substituted body is checked on its
    // own (e.g. `cat <(rm -rf /)` must not let `rm` ride inside the `cat` segment).
    if ((ch === "<" || ch === ">") && next === "(") {
      push();
      i++; // consume "("
      continue;
    }
    if (ch === ")" || ch === "`") {
      push();
      continue;
    }

    // Control operators: ; & && | || and newlines.
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "&" || ch === "|") {
      push();
      if (next === ch) {
        i++; // collapse && / ||
      }
      continue;
    }

    current += ch;
  }

  push();
  return segments;
}

/**
 * A canonical (lowercased) target matches a deny prefix when it starts with the
 * prefix, OR equals the prefix with its trailing space trimmed. Deny prefixes
 * carry a trailing space (`"npm install "`) so `npm installfoo` does not match;
 * that would also miss the bare command with no argument (`xargs npm install`,
 * where xargs supplies the package from stdin), so the exact-word form is
 * accepted too.
 */
function matchesDenyPrefixAt(
  target: string,
  prefix: string,
  start: number
): boolean {
  const p = prefix.toLowerCase();
  if (target.startsWith(p, start)) {
    return true;
  }
  const trimmed = p.trimEnd();
  // The exact-word form only matches when the rest of the target IS the word
  // (`xargs npm install`, where xargs supplies the package from stdin).
  return (
    trimmed !== p &&
    target.length - start === trimmed.length &&
    target.startsWith(trimmed, start)
  );
}

/**
 * A leading `VAR=value` assignment (env-style, e.g. `NIX_BIN=/usr/bin/nix cmd …`)
 * sets an environment variable for the command that follows — the value is DATA,
 * not the executable. Matching a deny prefix inside that value (`/usr/bin/nix`)
 * falsely denies an otherwise-harmless command. Return the offset of the first
 * token that is NOT such an assignment — the real command head. The command
 * that follows the assignments is still matched from there, so
 * `NIX_BIN=x nix run …` stays denied on the actual `nix run`.
 */
function skipLeadingAssignments(target: string): number {
  let start = 0;
  while (start < target.length) {
    const space = target.indexOf(" ", start);
    const tokenEnd = space === -1 ? target.length : space;
    const token = target.slice(start, tokenEnd);
    // `VAR=value` (name before `=`, value may be empty or path-qualified).
    if (!/^[a-z_][a-z0-9_]*=/i.test(token)) {
      break;
    }
    if (space === -1) {
      return target.length;
    }
    start = space + 1;
  }
  return start;
}

/**
 * Offset just past the last `/` of the token starting at `tokenStart`, or
 * `null` when that token carries no path. A path-qualified executable
 * (`/usr/bin/nix run …`, `/nix/store/…/bin/npm install …`) runs exactly the
 * same binary as the bare name, so the deny prefixes are tried there too.
 */
function commandNameOffset(target: string, tokenStart: number): number | null {
  const space = target.indexOf(" ", tokenStart);
  const tokenEnd = space === -1 ? target.length : space;
  const slash = target.lastIndexOf("/", tokenEnd - 1);
  if (slash < tokenStart) {
    return null;
  }
  return slash + 1;
}

/**
 * {@link matchesDenyPrefixAt} applied where the LEADING command name can start:
 * the first token past any `VAR=value` assignments (whose values are data, not
 * the executable), and past the path of a path-qualified executable.
 */
function matchesDenyPrefixAtCommandHead(
  target: string,
  prefix: string
): boolean {
  const head = skipLeadingAssignments(target);
  if (matchesDenyPrefixAt(target, prefix, head)) {
    return true;
  }
  const afterPath = commandNameOffset(target, head);
  return afterPath !== null && matchesDenyPrefixAt(target, prefix, afterPath);
}

export function enforceBashCommandPolicy(
  command: string,
  policy: BashCommandPolicy
): void {
  if (!command.trim()) {
    return;
  }

  const segments = splitShellCommands(command);
  if (segments.length === 0) {
    return;
  }

  const hasAllowlist = !policy.allowAll && policy.allowPrefixes.length > 0;

  for (const segment of segments) {
    const normalizedSegment = segment.toLowerCase();
    // Deny keys on the COMMAND HEAD — the executable the shell actually runs —
    // in the CANONICAL form (quoting/escaping/ANSI-C collapsed to what the shell
    // would execute), so `n\ix shell`, `"nix" shell`, `n"i"x shell`, and
    // `$'n\x69x' shell` all resolve to `nix shell`. Two heads are checked: the
    // segment as typed (past leading `VAR=value` assignments, see
    // {@link matchesDenyPrefixAtCommandHead}), and the segment with leading exec
    // wrappers peeled (`env nix …`/`sudo -u root nix …`/`timeout 5 nix …` →
    // `nix …`), so a wrapped install is denied by the wrapped command, not the
    // wrapper word. Because only the resolved head is matched — never an
    // argument — a data-only command's quoted argument (`printf "nix run"`) and
    // an assignment's value (`NIX_BIN=/usr/bin/nix echo`) are not false denials.
    const canonical = canonicalizeSegment(segment).code;
    const wrappedHead = stripExecWrappers(canonical);

    const denied = policy.denyPrefixes.some(
      (prefix) =>
        matchesDenyPrefixAtCommandHead(canonical, prefix) ||
        (wrappedHead !== null &&
          matchesDenyPrefixAtCommandHead(wrappedHead, prefix))
    );
    if (denied) {
      throw new Error("Bash command denied by policy");
    }

    if (hasAllowlist) {
      // Allow is checked against the RAW segment: a quoted/escaped command that
      // no longer matches an allow prefix must fall through to "not allowed",
      // never be spuriously permitted by canonicalizing.
      const allowed = policy.allowPrefixes.some((prefix) =>
        normalizedSegment.startsWith(prefix.toLowerCase())
      );
      if (!allowed) {
        throw new Error("Bash command not allowed by policy");
      }
    }
  }
}
