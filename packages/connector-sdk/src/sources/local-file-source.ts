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
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
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

      // Race-free pipeline:
      //
      //  1. List the source's relative file paths (no byte reads yet).
      //  2. Copy each into a staging dir.
      //  3. Hash bytes FROM THE STAGED COPY — so the hash and the bytes the
      //     Snapshot will later read are identical even if the live source
      //     gets rewritten between step 2 and step 3.
      //  4. Compute the canonical ref from those hashes.
      //  5. If `refs/<ref>` already exists (same content already cached),
      //     drop the staging dir. Else rename staging into place atomically.
      //
      // The Snapshot reads from the per-ref dir — never from the live source —
      // so `snapshot.ref` matches `sha256(snapshot.readFile(path))` for every
      // tracked path no matter what races happen on the source filesystem.
      const relPaths = await listRelativeFiles(this.#rootDir, this.#exclude);
      const stagingDir = `${this.#paths.root}/refs/.staging.${randomSuffix()}`;
      let stagingMoved = false;
      let refDir: string;
      let files: ManifestEntry[];
      let ref: string;
      try {
        await mkdir(stagingDir, { recursive: true });
        await copyFilesToStaging(this.#rootDir, stagingDir, relPaths);
        files = await hashStagedFiles(stagingDir, relPaths);
        ref = canonicalManifestRef(files);
        refDir = perRefDir(this.#paths.root, ref);
        if (await dirExists(refDir)) {
          // Same content already installed; throw away the staging copy.
          await rm(stagingDir, { recursive: true, force: true });
          stagingMoved = true;
        } else {
          await rename(stagingDir, refDir);
          stagingMoved = true;
        }
      } finally {
        if (!stagingMoved) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      const manifest: Manifest = {
        ref,
        files,
        fetched_at: new Date().toISOString(),
      };

      await writeManifest(this.#paths.manifestPath, manifest);
      await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'local' });
      // Also persist a per-ref copy so diffSinceRef can look up prior refs.
      await writePerRefManifest(this.#paths.root, manifest);
      // Keep the per-ref cache bounded — `refs/` accumulates a new dir per
      // distinct content state if the source is rewritten.
      await pruneOldRefDirs(this.#paths.root, MAX_REF_DIRS);

      return new DirectorySnapshot(refDir, ref);
    });
  }

  diffSinceRef(prevRef: string): Promise<FileDelta> {
    return withSourceLock(this.#uri, async () => {
      await requireMeta(this.#paths.metaPath, this.#uri);
      this.#exclude = await resolveCacheExclude(this.#rootDir);
      const files = await collectFilesFromLive(this.#rootDir, this.#exclude);
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

/** Max number of `refs/<hash>` per-ref directories kept on disk. */
const MAX_REF_DIRS = 3;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** List relative paths from the source root, applying the exclude predicate. */
async function listRelativeFiles(
  rootDir: string,
  exclude: (rel: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of walkDirectoryRelative(rootDir)) {
    if (exclude(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Copy each tracked file from `sourceRoot` into `stagingDir`. Prefers
 * copy-on-write (`COPYFILE_FICLONE`) on filesystems that support it
 * (APFS, btrfs, xfs/reflink); falls back to a full byte copy elsewhere.
 *
 * Why not hardlink: a hardlink shares the underlying inode. A subsequent
 * truncate-and-rewrite on the source file mutates the bytes the snapshot
 * is reading — the opposite of immutability. Copy-on-write copies (or
 * full copies) own their data, so writes through the source path don't
 * leak into the pinned snapshot.
 */
async function copyFilesToStaging(
  sourceRoot: string,
  stagingDir: string,
  relPaths: string[],
): Promise<void> {
  for (const rel of relPaths) {
    const src = join(sourceRoot, rel);
    const dst = join(stagingDir, rel);
    await mkdir(dirname(dst), { recursive: true });
    try {
      await copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTSUP') {
        await copyFile(src, dst);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Hash files directly from the live source root — used by `diffSinceRef()`,
 * which doesn't return a Snapshot and only needs a manifest to compare
 * against. Race-tolerant: a mid-walk write just shows up as part of the
 * next diff.
 */
async function collectFilesFromLive(
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
 * Hash files in the staging dir. The hash is computed from the BYTES THAT
 * WERE COPIED, so the returned manifest is consistent with what the
 * Snapshot will later expose via `readFile()` — even if the live source
 * was rewritten between the copy and the hash.
 */
async function hashStagedFiles(
  stagingDir: string,
  relPaths: string[],
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  for (const rel of relPaths) {
    const buf = await readFile(join(stagingDir, rel));
    const sha = createHash('sha256').update(buf).digest('hex');
    out.push({ path: rel, sha256: sha });
  }
  return out;
}

/**
 * Keep at most `keep` per-ref directories under `${root}/refs/`. Sorted by
 * mtime descending; the oldest are rm-rf'd. Snapshots already handed out
 * keep working as long as their backing dir wasn't pruned — `keep=3`
 * accommodates a fresh fetch plus two in-flight overlapping syncs.
 *
 * Ignores `.staging.*` directories (in-progress copies) and the per-ref
 * manifest JSON files (`<ref>.json`) which are kept indefinitely so
 * historical diffs work even after the data dir is gone.
 */
async function pruneOldRefDirs(root: string, keep: number): Promise<void> {
  const refsRoot = join(root, 'refs');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(refsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.staging.')) continue;
    const abs = join(refsRoot, ent.name);
    try {
      const s = await stat(abs);
      candidates.push({ name: ent.name, mtimeMs: s.mtimeMs });
    } catch {
      // Skip — concurrent prune from another process is fine.
    }
  }
  if (candidates.length <= keep) return;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates.slice(keep)) {
    await rm(join(refsRoot, c.name), { recursive: true, force: true }).catch(() => undefined);
  }
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
