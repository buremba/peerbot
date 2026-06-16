/**
 * GitSnapshot — Snapshot backed by an immutable git commit OID.
 *
 * Unlike `DirectorySnapshot`, this snapshot reads file contents via
 * `git.readBlob({oid, filepath})` against the captured commit, NOT from
 * the on-disk working tree. That gives us true immutability: a later
 * `fetch()` may move HEAD or rewrite the working tree, but blob OIDs for
 * the captured commit stay reachable in the shallow clone's object DB.
 *
 * Caveats:
 *  - `walkFiles` walks the captured commit's tree (`git.walk` with a single
 *    `TREE({ref})`). Result: files-as-they-existed-at-the-commit, not
 *    files-as-they-are-on-disk-right-now.
 *  - `readFile` / `readText` extract blob bytes from the object DB.
 *  - Path-security primitives mirror `DirectorySnapshot` lexically (absolute
 *    paths rejected, `..` escapes rejected, exclude predicate enforced).
 *  - No realpath/symlink defense — git's object model has no symlinks-as-
 *    filesystem-pointers. A blob with mode 120000 IS the link contents, not
 *    a follow-able pointer.
 */
import * as git from 'isomorphic-git';
import type nodeFsType from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Snapshot } from '../file-source.js';
import { matchesGlob } from './glob.js';

interface GitSnapshotOptions {
  exclude?: (relativePath: string) => boolean;
}

export class GitSnapshot implements Snapshot {
  readonly ref: string;
  readonly #dir: string;
  readonly #fs: typeof nodeFsType;
  readonly #exclude: (relativePath: string) => boolean;

  constructor(
    dir: string,
    ref: string,
    fs: typeof nodeFsType,
    options: GitSnapshotOptions = {},
  ) {
    this.#dir = dir;
    this.ref = ref;
    this.#fs = fs;
    this.#exclude = options.exclude ?? (() => false);
  }

  async *walkFiles(glob: string): AsyncIterable<string> {
    const collected: string[] = [];
    await git.walk({
      fs: this.#fs,
      dir: this.#dir,
      trees: [git.TREE({ ref: this.ref })],
      map: async (filepath, entries) => {
        if (filepath === '.') return undefined;
        if (!entries) return undefined;
        const [entry] = entries;
        if (!entry) return undefined;
        const type = await entry.type();
        if (type !== 'blob') return undefined;
        const posix = filepath.split(sep).join('/');
        if (this.#exclude(posix)) return undefined;
        if (matchesGlob(posix, glob)) collected.push(posix);
        return undefined;
      },
    });
    for (const p of collected) yield p;
  }

  async readFile(relativePath: string): Promise<Buffer> {
    const posix = this.#validateRel(relativePath);
    const { blob } = await git.readBlob({
      fs: this.#fs,
      dir: this.#dir,
      oid: this.ref,
      filepath: posix,
    });
    return Buffer.from(blob);
  }

  async readText(relativePath: string): Promise<string> {
    const buf = await this.readFile(relativePath);
    return buf.toString('utf8');
  }

  #validateRel(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`Snapshot.readFile: absolute paths are not allowed (${relativePath})`);
    }
    // Use a virtual root so `normalize`/`relative` behave consistently across
    // platforms without touching the real fs.
    const virtualRoot = '/__snap__';
    const joined = normalize(join(virtualRoot, relativePath));
    const rel = relative(virtualRoot, joined);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new Error(`Snapshot.readFile: path escapes snapshot root (${relativePath})`);
    }
    const posix = sep === '/' ? rel : rel.split(sep).join('/');
    if (this.#exclude(posix)) {
      throw new Error(`Snapshot.readFile: path is excluded from the snapshot (${relativePath})`);
    }
    return posix;
  }
}
