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

/**
 * Canonicalize a shell segment to the token string the shell would actually
 * execute: remove quote DELIMITERS while joining the fragments they wrap (so
 * `"nix"` → `nix`, `n"i"x` → `nix`, `n'i'x` → `nix`) and drop backslash escapes
 * (`n\ix` → `nix`). The detector matches against this canonical form so an
 * honestly-typed package manager is recognized however it is spelled.
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
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\" && i + 1 < segment.length) {
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
      } else {
        code += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
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
 * Best-effort detector for an honestly-typed package-manager install/acquire
 * command, used ONLY to return a helpful "declare it in nixPackages instead"
 * message (see {@link enforceBashPreflight}).
 *
 * This is NOT the security boundary and does not try to be airtight against
 * shell-quoting evasion. Actual enforcement is the sandbox binary-discovery
 * filter (`UNSANDBOXED_INTERPRETERS` in `just-bash-bootstrap.ts`): a package
 * manager that is not registered as a runnable command resolves to
 * "command not found" (exit 127) no matter how it is spelled or wrapped
 * (`"nix" run`, `env nix`, `sh -c '…'`, `git -c alias=!nix`), because the
 * lookup is on the RESOLVED binary name, which quoting cannot change. So this
 * detector canonicalizes quoting for good coverage of the common cases but
 * treats any miss as a UX gap, not a hole.
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
    const target = QUOTED_ARG_IS_DATA_COMMANDS.has(leadingCommand(code))
      ? dataStripped
      : code;
    if (!target) {
      return false;
    }
    return (
      DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
        target.startsWith(prefix.toLowerCase())
      ) ||
      DIRECT_PACKAGE_INSTALL_PATTERNS.some((pattern) => pattern.test(target))
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
    // Deny is checked against the CANONICAL form (quoting/escaping collapsed to
    // what the shell would execute), so `n\ix shell`, `"nix" shell`, and
    // `n"i"x shell` all resolve to `nix shell` and cannot slip a deny prefix.
    // Canonicalizing can only make a deny prefix match MORE, so it is safe.
    const denyTarget = canonicalizeSegment(segment).code;

    const denied = policy.denyPrefixes.some((prefix) =>
      denyTarget.startsWith(prefix.toLowerCase())
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
