import type { ToolsConfig } from "@lobu/core";

import {
  blankQuotedSpans,
  INTERPRETER_DASH_C,
  matchesBeforeArgumentData,
  splitShellCommands,
} from "./bash-command-parser";

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
 * Advisory detector for an honestly-typed package-manager install/acquire
 * command, used to return a helpful "declare it in nixPackages instead" message
 * (see {@link enforceBashPreflight}).
 *
 * This is a conservative TEXT hint, NOT the security boundary. It does not try
 * to out-parse the shell, so it misses a quoted, escaped, or path-qualified
 * name (`"nix" run`, `n\ix run`, `/usr/bin/nix run`), a manager behind an exec
 * wrapper (`env nix run`, `xargs npm install`), a name built at runtime, and
 * the body of an interpreter reached by path or long option (`/bin/bash -c`,
 * `bash --login -c`). It also over-denies a manager named as an argument in a
 * position the argument-data words do not cover (`for f in npm install`,
 * `sudo grep nix run x`).
 *
 * That direction is chosen, not tolerated: over-denial is a confusing error on
 * a harmless command, under-detection is a missing guard rail. So every
 * uncertain case falls back to the base detector and flags, and only a word
 * whose operand provably cannot be a command narrows it.
 *
 * Those misses are not holes on the local backend: the manager is never a
 * runnable command there. `UNSANDBOXED_INTERPRETERS` in
 * `just-bash-bootstrap.ts` keeps it out of the just-bash registry, and that
 * lookup is on the RESOLVED binary name, which quoting and paths cannot
 * change — so the spellings above end in "command not found" regardless.
 * Declared `nixPackages` is the sanctioned way to get tooling.
 *
 * Remote runtime providers (opt-in, e.g. `vercel`) have no discovery filter,
 * but the shared preflight runs before dispatch, so these deny prefixes apply
 * there too and are what keeps a manager from reaching the provider at all.
 * Loosening that for the sandbox tier would be a deliberate, separate change.
 *
 * Making this matcher airtight means reimplementing bash's lexer; attempts to
 * do so produced false positives on honest commands and no gain in
 * enforcement. Prefer widening the discovery filter over widening this regex.
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

  // Scan the command with quoted DATA blanked out and each data word's operands
  // dropped, so a manager merely NAMED cannot match. Both scrubs are advisory
  // and fail toward flagging: whatever they cannot prove to be data is matched.
  if (matchesBeforeArgumentData(blankQuotedSpans(trimmed), matches)) {
    return true;
  }

  // Then scan `sh -c '…'` bodies, where the quoted text IS a command.
  INTERPRETER_DASH_C.lastIndex = 0;
  for (const m of trimmed.matchAll(INTERPRETER_DASH_C)) {
    const body = m[2]?.trim();
    if (body && matchesBeforeArgumentData(blankQuotedSpans(body), matches)) {
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
