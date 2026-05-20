/**
 * @lobu/pgvector-embedded
 *
 * `embedded-postgres` ships vanilla PostgreSQL binaries with no pgvector. This
 * package carries small prebuilt pgvector artifacts (the compiled extension
 * library + its `.control` / `.sql` files) for each platform `embedded-postgres`
 * supports, and injects the host platform's artifact into the live
 * `@embedded-postgres/<platform>/native` tree so `CREATE EXTENSION vector`
 * resolves at runtime.
 *
 * Artifacts are built by `scripts/build.sh` (one platform per CI matrix cell)
 * against a same-major PostgreSQL — the extension ABI is stable within a major,
 * so a library built against PG 18.x loads into `embedded-postgres`'s PG 18.x.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREBUILT_ROOT = join(PACKAGE_ROOT, "prebuilt");

/** Platform key matching `embedded-postgres`'s package suffixes (`darwin-arm64`, `linux-x64`, …). */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Directory holding the prebuilt pgvector files for a platform. */
export function prebuiltDir(platform: string = currentPlatformKey()): string {
  return join(PREBUILT_ROOT, platform);
}

/** Whether a usable prebuilt pgvector artifact exists for the platform. */
export function hasPrebuilt(platform: string = currentPlatformKey()): boolean {
  return existsSync(join(prebuiltDir(platform), "vector.control"));
}

/**
 * Resolve the `native` directory of the installed `@embedded-postgres/<platform>`
 * package (the one that holds `bin/`, `lib/`, `share/`). Throws with an
 * actionable message if the platform binary package isn't installed.
 */
export function resolveEmbeddedNativeDir(
  platform: string = currentPlatformKey()
): string {
  let entry: string;
  try {
    // The platform package uses a string `exports` ("./dist/index.js"), so only
    // the package root resolves; walk up from there to `native`.
    entry = require.resolve(`@embedded-postgres/${platform}`);
  } catch {
    throw new Error(
      `@lobu/pgvector-embedded: @embedded-postgres/${platform} is not installed. ` +
        "Install embedded-postgres so its host-platform binary package is present."
    );
  }
  return join(dirname(entry), "..", "native");
}

/**
 * embedded-postgres' macOS native libs ship only as the fully-versioned
 * `lib<name>.<major>.<minor>.dylib`, but the Postgres binaries link against both
 * the major SONAME (`lib<name>.<major>.dylib`) and the unversioned linker name
 * (`lib<name>.dylib`, e.g. postgres' `@loader_path/../lib/libicui18n.dylib`) —
 * and the @embedded-postgres/darwin-* packages omit those symlinks. Without them
 * `initdb`/`postgres` abort with `Library not loaded`. Recreate both link levels
 * idempotently, pointing at the real versioned file. No-op off macOS (Linux ships
 * the `.so.<major>` links) and when a link already exists.
 */
export function ensureNativeLibSonames(
  nativeDir: string = resolveEmbeddedNativeDir()
): void {
  if (process.platform !== "darwin") return;
  const libDir = join(nativeDir, "lib");
  if (!existsSync(libDir)) return;
  for (const file of readdirSync(libDir)) {
    // lib<base>.<major>.<minor>.dylib → { lib<base>.<major>.dylib, lib<base>.dylib }
    const match = file.match(/^(lib.+?)\.(\d+)\.\d+\.dylib$/);
    if (!match) continue;
    const [, base, major] = match;
    for (const soname of [`${base}.${major}.dylib`, `${base}.dylib`]) {
      const link = join(libDir, soname);
      if (existsSync(link)) continue;
      try {
        symlinkSync(file, link); // relative target within libDir
      } catch {
        // Best-effort: a race or perms issue surfaces as the real initdb error.
      }
    }
  }
}

/**
 * Copy the host platform's prebuilt pgvector files into an embedded-postgres
 * `native` tree so `CREATE EXTENSION vector` works, and hydrate the macOS ICU
 * SONAME symlinks so `initdb` can link. Idempotent — returns early if pgvector
 * is already present in the tree.
 *
 * @param nativeDir absolute path to `.../native`; defaults to the resolved
 *   host-platform `@embedded-postgres` package.
 */
export function injectPgvector(
  nativeDir: string = resolveEmbeddedNativeDir(),
  platform: string = currentPlatformKey()
): void {
  // Always (re)hydrate the dylib SONAME symlinks — needed for initdb to link
  // even when pgvector was already injected on a prior run.
  ensureNativeLibSonames(nativeDir);

  const libDst = join(nativeDir, "lib", "postgresql");
  const extDst = join(nativeDir, "share", "postgresql", "extension");

  // Already injected (or shipped) — nothing to do.
  if (existsSync(join(extDst, "vector.control"))) return;

  if (!hasPrebuilt(platform)) {
    throw new Error(
      `@lobu/pgvector-embedded: no prebuilt pgvector for "${platform}". ` +
        "Run scripts/build.sh for this platform, or set DATABASE_URL to use an external Postgres."
    );
  }

  const src = prebuiltDir(platform);
  mkdirSync(libDst, { recursive: true });
  mkdirSync(extDst, { recursive: true });

  for (const file of readdirSync(src)) {
    if (!file.startsWith("vector")) continue;
    // The compiled library (vector.so / vector.dylib) goes to lib/postgresql;
    // the control + version SQL files go to share/postgresql/extension.
    const dest =
      file.endsWith(".so") || file.endsWith(".dylib") ? libDst : extDst;
    cpSync(join(src, file), join(dest, file));
  }
}
