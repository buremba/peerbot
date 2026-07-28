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
  // New-style nix CLI. `nix shell`/`run`/`develop` put arbitrary packages on
  // PATH or fetch-and-execute them and `nix build`/`nix-store` realise arbitrary
  // derivations — the same capability the old-style commands above already
  // denied. A bare `nix ` prefix covers every subcommand (conservative, like
  // `brew `); `nixfmt` and friends keep working because the prefix needs the
  // trailing space. This matcher only recognizes the honestly-typed leading
  // command; what actually contains a package manager differs per backend —
  // see the header on isDirectPackageInstallCommand.
  "nix ",
  "nix-build ",
  "nix-store ",
  "nix-channel ",
  "nix-instantiate ",
  "nix-prefetch-url ",
  "nix-collect-garbage ",
  "nix-copy-closure ",
  // Ad-hoc package runners: fetch-and-run a tool that is not installed.
  // `npx`/`bunx` are absent — they prefer already-installed local binaries.
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
  /(^|[\s;|&()])(?:sudo\s+)?(?:apt|apt-get|yum|dnf|apk|pacman|zypper|brew)\s+(?:install|upgrade|add)\b/i,
  /(^|[\s;|&()])(?:sudo\s+)?(?:nix-shell|nix-env)\b/i,
  // New-style nix subcommands and the nix-* helpers, recognized after a shell
  // operator or `sudo` (leading forms are already covered by the prefix list).
  /(^|[\s;|&()])(?:sudo\s+)?nix\s+(?:profile|shell|run|develop|build|eval|flake|store|copy|bundle|repl|search|edit|print-dev-env|why-depends|derivation|realisation|registry|upgrade-nix)\b/i,
  /(^|[\s;|&()])(?:sudo\s+)?nix-(?:build|store|channel|instantiate|prefetch-url|collect-garbage|copy-closure)\b/i,
  /(^|[\s;|&()])(?:pip|pip3)\s+install\b/i,
  /(^|[\s;|&()])uv\s+pip\s+install\b/i,
  /(^|[\s;|&()])uv\s+(?:tool\s+(?:install|run|upgrade)|add)\b/i,
  /(^|[\s;|&()])uvx\b/i,
  /(^|[\s;|&()])pipx\s+(?:install|run|upgrade|upgrade-all|inject|reinstall|reinstall-all|runpip)\b/i,
  /(^|[\s;|&()])npm\s+(?:install|i)\b/i,
  /(^|[\s;|&()])pnpm\s+(?:install|add|dlx)\b/i,
  /(^|[\s;|&()])yarn\s+(?:install|add|global\s+add|dlx)\b/i,
  /(^|[\s;|&()])bun\s+(?:install|add)\b/i,
  /(^|[\s;|&()])cargo\s+install\b/i,
  /(^|[\s;|&()])go\s+install\b/i,
  /(^|[\s;|&()])gem\s+install\b/i,
  /(^|[\s;|&()])poetry\s+add\b/i,
  /(^|[\s;|&()])composer\s+require\b/i,
];

/**
 * An interpreter invoked with `-c` runs its QUOTED argument as a command, so
 * that body is a command position and must be scanned. Everywhere else a quote
 * introduces data (`git commit -m '…'`), which is why the patterns above do not
 * treat a quote character as a word boundary.
 *
 * The interpreter itself must be in COMMAND position — start of the string, a
 * newline, or just after a shell operator. Without that anchor,
 * `echo sh -c 'nix run x'` would have its argument text scanned as if it were
 * executed, and a newline-delimited `sh -c` would be missed entirely.
 *
 * `c` may sit anywhere in a short-option cluster and may follow other options
 * given as separate words, so `-lc`, `-ce`, `-cx` and `bash -euo pipefail -c`
 * all reach the body. Matching only clusters that END in `c` missed every one
 * of those, including the very common `set -euo pipefail` idiom.
 */
const INTERPRETER_DASH_C =
  /(?:^|[;|&(\n])[^\S\n]*(?:ba|z|k|a|da)?sh\s+(?:-[a-z]*\s+|-[a-z]*\s+\S+\s+)*-[a-z]*c[a-z]*\s+(['"])([\s\S]*?)\1/gi;

/**
 * Replace non-command text with spaces, preserving offsets and delimiters:
 * the contents of quoted spans, and anything after an unquoted `#` comment.
 * A word boundary inside either then cannot open a command position, so
 * `git commit -m 'document nix shell support'` and `echo done # nix run x`
 * no longer match while the surrounding real command is scanned normally.
 *
 * Offsets are preserved rather than the span deleted so that `foo'a'bar` does
 * not collapse into a new adjacent token.
 *
 * A heredoc body (`cat <<EOF … EOF`) is NOT stripped: recognizing one means
 * tracking the delimiter across lines, which is the bash-lexer rabbit hole this
 * matcher deliberately stays out of. A heredoc that quotes an install command
 * is therefore still flagged — an over-denial on an unusual command, not a hole.
 */
function blankQuotedSpans(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      // A backslash escape inside double quotes keeps the next char quoted.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        out += "  ";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    // `#` opens a comment only at the START of a word — after whitespace, a
    // shell operator (`echo hi;# …`), or at the very beginning. Mid-token it is
    // an ordinary character and must stay one, since `nix run nixpkgs#hello`
    // depends on it. Blank to end of line, keeping the newline so later lines
    // are still scanned.
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(text[i - 1] as string))) {
      out += "#";
      i++;
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Advisory detector for an honestly-typed package-manager install/acquire
 * command, used to return a helpful "declare it in nixPackages instead" message
 * (see {@link enforceBashPreflight}).
 *
 * This is a conservative TEXT hint, not the security boundary, and it does NOT
 * try to out-parse the shell: a quoted or escaped executable name (`"nix" run`,
 * `n\ix run`, `$'n\x69x' run`), a path-qualified one (`/usr/bin/nix run`,
 * `/nix/store/<hash>/bin/nix run`), a package manager launched through an exec
 * wrapper (`env nix run`, `xargs npm install`), or a name assembled at runtime
 * is NOT recognized here. The same goes for an interpreter reached by a path or
 * a long option before `-c` (`/bin/bash -c '…'`, `bash --login -c '…'`,
 * `env bash -c '…'`): the body is not scanned.
 *
 * None of those are holes on the local backend, because the package manager
 * itself is never a runnable command there: `UNSANDBOXED_INTERPRETERS` in
 * `just-bash-bootstrap.ts` keeps it out of the just-bash registry, and that
 * lookup is on the RESOLVED binary name, which quoting and paths cannot change.
 * Verified — each of these exits 127 with the manager never running:
 *
 *   /bin/bash -c 'nix run x'        -> bash: nix: command not found
 *   /usr/bin/env bash -c 'nix run x'-> bash: nix: command not found
 *   bash --login -c 'nix run x'     -> bash: --login: No such file or directory
 *   zsh -c 'uvx x'                  -> bash: zsh: command not found
 *
 * Note the mechanism varies: an unregistered interpreter (`zsh`) fails on its
 * own name, while just-bash's `bash` builtin accepts the invocation and fails
 * on `nix` inside the body. Either way the install does not happen.
 *
 * Trying to make this matcher airtight means reimplementing bash's lexer. That
 * was attempted across several rounds of review on #2259 and produced a steady
 * stream of false positives on honest commands (`git commit -m 'nix shell
 * support'`, `echo done # nix run x`, `echo sh -c '…'`) for no gain in
 * enforcement. Prefer widening the discovery filter over widening this regex.
 *
 * KNOWN OVER-DENIAL: the patterns treat any whitespace as a command boundary,
 * so a manager named as a plain ARGUMENT is flagged too — `echo uvx cowsay`,
 * `git log --grep nix run`, `man nix run`. That is deliberate on main (see the
 * "intentionally conservative" cases in tool-policy-edge-cases.test.ts, which
 * pin `echo npm install` as detected) and predates the nix entries here.
 * Anchoring the patterns to real command positions fixes it for every manager,
 * but flips that documented contract, so it belongs in its own change rather
 * than riding along with this one.
 *
 * It is advisory on BOTH bash backends, for different reasons:
 *
 *  - Local embedded just-bash (the default, and the unattended/scheduled path):
 *    enforcement is the binary-discovery filter (`UNSANDBOXED_INTERPRETERS` in
 *    `just-bash-bootstrap.ts`). A package manager that is not registered as a
 *    runnable command resolves to "command not found" (exit 127) however it is
 *    spelled, quoted, or path-qualified, because the lookup is on the RESOLVED
 *    binary name. Declared `nixPackages` is the sanctioned way to get tooling.
 *
 *  - Remote runtime providers (opt-in, e.g. `vercel`): the runtime is itself a
 *    sandbox — read-only base image rooted at its own workspace, egress under
 *    the provider's network policy — so an install there escapes neither into
 *    the worker nor into a later scheduled run, and there is no discovery
 *    filter on that path. The shared preflight still runs before dispatch,
 *    though, so the deny prefixes below apply to remote execution too: this
 *    hint is what keeps `nix`/`apt` from reaching the provider at all. That
 *    predates this change (`apt `, `nix-shell `, `nix-env ` were already
 *    denied); loosening it for the sandbox tier would be a deliberate,
 *    separate decision, not a side effect of widening the nix entries.
 */
export function isDirectPackageInstallCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  const matches = (text: string): boolean =>
    DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES.some((prefix) =>
      text.startsWith(prefix.toLowerCase())
    ) || DIRECT_PACKAGE_INSTALL_PATTERNS.some((pattern) => pattern.test(text));

  // Scan the command with quoted DATA blanked out, so only real command
  // positions can match.
  if (matches(blankQuotedSpans(trimmed))) {
    return true;
  }

  // Then scan `sh -c '…'` bodies, where the quoted text IS a command.
  INTERPRETER_DASH_C.lastIndex = 0;
  for (const m of trimmed.matchAll(INTERPRETER_DASH_C)) {
    const body = m[2]?.trim();
    if (body && matches(blankQuotedSpans(body))) {
      return true;
    }
  }

  return false;
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
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      // Inside double quotes only `$( … )` / backticks introduce a new command;
      // everything else (including `;`, `&&`, `|`) is literal data.
      if (ch === '"') {
        inDouble = false;
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

    // Backslash-newline is LINE CONTINUATION: the shell deletes both characters
    // before tokenizing, so `r\<newline>m -rf /` runs as `rm -rf /`. Drop both
    // rather than keeping them as text, or a deny prefix can be split in half
    // and evaded.
    if (ch === "\\" && next === "\n") {
      i++;
      continue;
    }

    // Any other outside-quote backslash escapes the next character, making an
    // escaped metacharacter literal data — `echo foo\; nix run` is ONE `echo`,
    // not two commands. Consume both so the escaped `;`/`|`/`&` is not read as
    // a segment boundary.
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
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

    const denied = policy.denyPrefixes.some((prefix) =>
      normalizedSegment.startsWith(prefix.toLowerCase())
    );
    if (denied) {
      throw new Error("Bash command denied by policy");
    }

    if (hasAllowlist) {
      const allowed = policy.allowPrefixes.some((prefix) =>
        normalizedSegment.startsWith(prefix.toLowerCase())
      );
      if (!allowed) {
        throw new Error("Bash command not allowed by policy");
      }
    }
  }
}
