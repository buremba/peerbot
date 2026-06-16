/**
 * Concrete `Snapshot` backed by a directory on disk. Reused by all three
 * source implementations — the rootDir stays hidden from the connector.
 *
 * Two layers of defense:
 *
 *  1. Lexical: `#resolveSafe` rejects absolute paths and `..` escapes.
 *  2. Runtime: `readFile` / `readText` resolve the *real* path (following
 *     symlinks) and verify it still falls under the snapshot root. This
 *     blocks symlink-based escape from extracted tarballs / local sources
 *     that happen to contain a `link -> /etc/passwd` symlink.
 *
 * An optional `exclude` predicate skips entries during `walkFiles` AND
 * denies them in `readFile`/`readText` — used to hide `.git/` from git
 * snapshots and `.lobu-cache/` from local-source snapshots rooted at the
 * workspace.
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Snapshot } from '../file-source.js';
import { matchesGlob, walkDirectoryRelative } from './glob.js';

interface DirectorySnapshotOptions {
  /**
   * Predicate run against each POSIX-style relative path during walk and
   * read. Returning `true` excludes the path. Used to hide internal dirs
   * (`.git/` for git sources, `.lobu-cache/` for local sources rooted at
   * the workspace).
   */
  exclude?: (relativePath: string) => boolean;
}

export class DirectorySnapshot implements Snapshot {
  readonly ref: string;
  /** @internal — NOT exported on the public Snapshot interface. */
  readonly #rootDir: string;
  readonly #realRootDir: Promise<string>;
  readonly #exclude: (relativePath: string) => boolean;

  constructor(rootDir: string, ref: string, options: DirectorySnapshotOptions = {}) {
    this.#rootDir = resolve(rootDir);
    this.ref = ref;
    this.#exclude = options.exclude ?? (() => false);
    // Realpath the root once; symlink checks resolve against the canonical
    // form so we don't reject a legitimate request just because the cache
    // directory itself sits under a symlinked path.
    this.#realRootDir = realpath(this.#rootDir).catch(() => this.#rootDir);
  }

  async *walkFiles(glob: string): AsyncIterable<string> {
    for await (const rel of walkDirectoryRelative(this.#rootDir)) {
      if (this.#exclude(rel)) continue;
      if (matchesGlob(rel, glob)) yield rel;
    }
  }

  async readFile(relativePath: string): Promise<Buffer> {
    return readFile(await this.#resolveSafe(relativePath));
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(await this.#resolveSafe(relativePath), 'utf8');
  }

  /**
   * Resolve `relativePath` inside `rootDir`. Layered defenses:
   *  1. Reject absolute paths.
   *  2. Reject `..` escapes (lexical).
   *  3. Reject paths matched by the exclude predicate.
   *  4. Resolve the path with `realpath()` (follows symlinks). Verify the
   *     canonical form still falls under the canonical root.
   */
  async #resolveSafe(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new Error(`Snapshot.readFile: absolute paths are not allowed (${relativePath})`);
    }
    const joined = normalize(join(this.#rootDir, relativePath));
    const rel = relative(this.#rootDir, joined);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new Error(`Snapshot.readFile: path escapes snapshot root (${relativePath})`);
    }
    const posixRel = sep === '/' ? rel : rel.split(sep).join('/');
    if (this.#exclude(posixRel)) {
      throw new Error(`Snapshot.readFile: path is excluded from the snapshot (${relativePath})`);
    }

    // Runtime defense: follow symlinks and verify the target is under root.
    let realTarget: string;
    try {
      realTarget = await realpath(joined);
    } catch (err) {
      // File doesn't exist or isn't reachable — let readFile() surface the
      // canonical ENOENT.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return joined;
      throw err;
    }
    const realRoot = await this.#realRootDir;
    const relReal = relative(realRoot, realTarget);
    if (relReal.startsWith('..') || isAbsolute(relReal)) {
      throw new Error(
        `Snapshot.readFile: path resolves outside snapshot root via symlink (${relativePath})`,
      );
    }
    return realTarget;
  }
}
