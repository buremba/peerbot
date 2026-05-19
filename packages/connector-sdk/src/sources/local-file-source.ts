/**
 * LocalFileSource — adapter over a local directory.
 *
 * URI shape: `file:///absolute/path/`
 *
 *  - `fetch()` does NOT copy files. The snapshot points at the local path
 *    directly. It DOES compute and persist a manifest in the SDK cache so
 *    `diffSinceRef()` can compare hashes across calls.
 *  - `ref` is the canonical manifest hash (sha256 of sorted `(path, sha256)`
 *    pairs).
 *  - `diffSinceRef(prevRef)`: re-walks the directory, builds a fresh manifest,
 *    and diffs it against whichever stored manifest happens to match
 *    `prevRef`. If no stored manifest matches (i.e. the cache was cleared
 *    between runs), the diff is empty for `added` / `modified` and the prev
 *    side is treated as unknown — see `diffSinceRef` JSDoc.
 */

import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import type { FileDelta, FileSystemSource, Snapshot } from '../file-source.js';
import {
  type CachePaths,
  type Manifest,
  type ManifestEntry,
  canonicalManifestRef,
  cachePathsFor,
  defaultCacheRoot,
  diffManifests,
  readAndVerifyMeta,
  readManifest,
  requireMeta,
  withSourceLock,
  writeManifest,
  writeMeta,
} from './cache.js';
import { walkDirectoryRelative } from './glob.js';
import { DirectorySnapshot } from './snapshot.js';

export class LocalFileSource implements FileSystemSource {
  readonly #uri: string;
  readonly #rootDir: string;
  readonly #paths: CachePaths;
  /**
   * When the local source root happens to *contain* the SDK cache dir
   * (`${WORKSPACE_DIR}/.lobu-cache`) — typical when the source is the
   * workspace root, OR when WORKSPACE_DIR is nested inside the source —
   * we must NOT ingest our own cache files, or every fetch() would mutate
   * the ref and self-pollute.
   *
   * Resolved at fetch() time using realpath() on both source root and the
   * cache directory, so we exclude exactly the right subtree no matter
   * where the cache lives relative to the source. If the cache is outside
   * the source entirely, the predicate excludes nothing.
   */
  #exclude: (relativePath: string) => boolean = () => false;

  constructor(uri: string) {
    if (!uri.startsWith('file://')) {
      throw new Error(`LocalFileSource: expected file:// URI, got ${uri}`);
    }
    this.#uri = uri;
    this.#rootDir = fileURLToPath(uri);
    this.#paths = cachePathsFor(uri);
  }

  fetch(): Promise<Snapshot> {
    return withSourceLock(this.#uri, async () => {
      const s = await stat(this.#rootDir).catch(() => null);
      if (!s || !s.isDirectory()) {
        throw new Error(`LocalFileSource: ${this.#rootDir} is not a directory`);
      }

      await mkdir(this.#paths.root, { recursive: true });
      await readAndVerifyMeta(this.#paths.metaPath, this.#uri);

      // Recompute exclude predicate each fetch(): the cache dir's location
      // relative to the source can shift if WORKSPACE_DIR changes between
      // calls (different process, different cwd).
      this.#exclude = await resolveCacheExclude(this.#rootDir);

      const files = await collectFiles(this.#rootDir, this.#exclude);
      const ref = canonicalManifestRef(files);
      const manifest: Manifest = {
        ref,
        files,
        fetched_at: new Date().toISOString(),
      };

      // Materialise an immutable snapshot of the source as it exists right
      // now into `${root}/refs/<ref>/`. Hardlink each file (cheap, no
      // bytes copied); fall back to a real copy on cross-device boundaries
      // (`EXDEV`). Once installed, the per-ref dir is never overwritten,
      // so any Snapshot holding it observes stable bytes even if the source
      // mutates underneath.
      const refDir = perRefDir(this.#paths.root, ref);
      if (!(await dirExists(refDir))) {
        await installRefDir(this.#rootDir, refDir, files);
      }

      await writeManifest(this.#paths.manifestPath, manifest);
      await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'local' });
      // Also persist a per-ref copy so diffSinceRef can look up prior refs.
      await writePerRefManifest(this.#paths.root, manifest);

      return new DirectorySnapshot(refDir, ref);
    });
  }

  diffSinceRef(prevRef: string): Promise<FileDelta> {
    return withSourceLock(this.#uri, async () => {
      await requireMeta(this.#paths.metaPath, this.#uri);
      this.#exclude = await resolveCacheExclude(this.#rootDir);
      const files = await collectFiles(this.#rootDir, this.#exclude);
      const curRef = canonicalManifestRef(files);
      if (curRef === prevRef) return { added: [], modified: [], removed: [] };

      const prev = await readPerRefManifest(this.#paths.root, prevRef);
      const next: Manifest = { ref: curRef, files, fetched_at: new Date().toISOString() };

      if (!prev) {
        // No record of the previous ref — caller's checkpoint references a ref
        // we no longer have on disk. Treat as "everything is new" so the
        // connector re-ingests rather than silently dropping data.
        return { added: files.map((f) => f.path), modified: [], removed: [] };
      }
      return diffManifests(prev, next);
    });
  }
}

/**
 * Compute the exclude predicate for `.lobu-cache`. Realpaths both source root
 * and `${cacheRoot}/.lobu-cache`, then:
 *   - If the cache dir is contained under the source root, exclude that exact
 *     relative subtree (POSIX-separated).
 *   - Otherwise return a no-op predicate — no exclusion needed.
 *
 * This handles three layouts correctly:
 *   (a) source root === workspace root → exclude `.lobu-cache/`
 *   (b) WORKSPACE_DIR is nested inside source (e.g. `source/workspace/`) →
 *       exclude `workspace/.lobu-cache/`
 *   (c) workspace lives outside source → no exclusion
 *
 * Realpath defends against symlinked workspace dirs.
 */
async function resolveCacheExclude(
  sourceRoot: string,
): Promise<(relativePath: string) => boolean> {
  const cacheBase = join(defaultCacheRoot(), '.lobu-cache');
  const realSource = await realpath(sourceRoot).catch(() => sourceRoot);
  const realCache = await realpath(cacheBase).catch(() => cacheBase);
  const rel = relative(realSource, realCache);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    // cache is outside source (or coincides with the source root, which is
    // degenerate — nothing meaningful to exclude). No-op predicate.
    return () => false;
  }
  const posixRel = sep === '/' ? rel : rel.split(sep).join('/');
  const prefix = `${posixRel}/`;
  return (relPath) => relPath === posixRel || relPath.startsWith(prefix);
}

function perRefDir(root: string, ref: string): string {
  return join(root, 'refs', ref);
}

async function dirExists(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isDirectory();
}

/**
 * Build `${refDir}` by copying each tracked file under it. Prefers
 * copy-on-write (`COPYFILE_FICLONE`) on filesystems that support it
 * (APFS, btrfs, xfs/reflink) — cheap and isolates writes. Falls back to
 * a full byte copy on filesystems that don't support reflinks.
 *
 * Stages into a sibling `.tmp.<n>` dir then renames into place so a crash
 * leaves only the staging dir behind (cleaned by the next install attempt)
 * and never a half-populated refDir.
 *
 * Why not hardlink: a hardlink shares the underlying inode. A subsequent
 * truncate-and-rewrite on the source file mutates the bytes the snapshot
 * is reading — the opposite of immutability. Copy-on-write copies (or
 * full copies) own their data, so writes through the source path don't
 * leak into the pinned snapshot.
 */
async function installRefDir(
  sourceRoot: string,
  refDir: string,
  files: ManifestEntry[],
): Promise<void> {
  const stagingDir = `${refDir}.tmp.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await mkdir(stagingDir, { recursive: true });
    for (const f of files) {
      const src = join(sourceRoot, f.path);
      const dst = join(stagingDir, f.path);
      await mkdir(dirname(dst), { recursive: true });
      try {
        // COPYFILE_FICLONE: reflink if the FS supports it, full copy otherwise.
        await copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
      } catch (err) {
        // Fallback for kernels/FSes that reject the FICLONE flag outright.
        if ((err as NodeJS.ErrnoException).code === 'ENOTSUP') {
          await copyFile(src, dst);
        } else {
          throw err;
        }
      }
    }
    await rename(stagingDir, refDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function collectFiles(
  rootDir: string,
  exclude: (rel: string) => boolean,
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  for await (const rel of walkDirectoryRelative(rootDir)) {
    if (exclude(rel)) continue;
    const abs = join(rootDir, rel);
    const buf = await readFile(abs);
    const sha = createHash('sha256').update(buf).digest('hex');
    out.push({ path: rel, sha256: sha });
  }
  return out;
}

/**
 * Per-ref manifest storage under `<root>/refs/<ref>.json`. Lets a connector
 * keep checkpointing arbitrary `prevRef`s without us guessing.
 */
async function writePerRefManifest(root: string, manifest: Manifest): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'refs'), { recursive: true });
  await writeManifest(join(root, 'refs', `${manifest.ref}.json`), manifest);
}

async function readPerRefManifest(root: string, ref: string): Promise<Manifest | null> {
  return readManifest(join(root, 'refs', `${ref}.json`));
}
