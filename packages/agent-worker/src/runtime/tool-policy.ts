import {
  type BashCommandPolicy,
  DEFAULT_PACKAGE_MANAGER_DENY_PREFIXES,
} from "@lobu/core";
import {
  blankQuotedSpans,
  INTERPRETER_DASH_C,
  matchesBeforeArgumentData,
  splitShellCommands,
} from "./bash-command-parser";

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
 * Those misses are not holes on the default local backend: the manager is not
 * a runnable command there. `UNSANDBOXED_INTERPRETERS` in
 * `embedded/just-bash-bootstrap.ts` keeps it out of the just-bash registry,
 * and that lookup is on the RESOLVED binary name, which quoting and paths
 * cannot change — so the spellings above end in "command not found"
 * regardless. Declared `nixPackages` is the sanctioned way to get tooling.
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
