/**
 * Resolution for local takeout archive directories.
 *
 * These are absolute machine-local paths, so they can only come from the
 * environment. Resolve them strictly: a relative fallback like `./takeout/x` is
 * a valid-looking string that `lobu apply` happily writes over a correct
 * absolute path, silently pointing prod at a directory that does not exist.
 * That is not hypothetical — an apply run without these vars is what set every
 * prod `takeout_dir` to `./takeout/...`, after which every takeout feed read an
 * empty directory until it was repaired by hand.
 *
 * Lives in its own module (rather than inline in `lobu.config.ts`) so the
 * resolution logic is testable without importing `@lobu/cli`.
 */

/**
 * Resolve one takeout directory, or throw naming the variable that is missing.
 *
 * Never returns null: prune is on, so a missing path would drop the feed from
 * the apply plan and DELETE it from prod rather than leave it alone.
 */
export function localTakeoutDir(envName: string, fallback: string): string {
  const explicit = process.env[envName];
  if (explicit) return explicit;
  const root = process.env.LOCAL_TAKEOUT_ROOT;
  if (root) return `${root}/${fallback}`;
  throw new Error(
    `${envName} is not set (and no LOCAL_TAKEOUT_ROOT fallback). ` +
      `Set it to the absolute path of the extracted archive before applying — ` +
      `applying without it would overwrite the stored takeout_dir in prod.`
  );
}

/**
 * A feed config whose `takeout_dir` resolves lazily, on read.
 *
 * Resolving at module scope would break scoped applies that never touch
 * connections: `lobu apply --only agents` loads the config and would exit at
 * import even though it skips every feed here. Deferring to property access
 * moves the check to connection mapping, so a full apply still fails closed.
 */
export function takeoutConfig(
  envName: string,
  fallback: string
): { takeout_dir: string } {
  return {
    get takeout_dir(): string {
      return localTakeoutDir(envName, fallback);
    },
  };
}
