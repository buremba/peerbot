/**
 * LocalFileSource — adapter over a local directory.
 *
 * URI shape: `file:///absolute/path/`
 *
 *  - `fetch()` stream-copies the source tree into a per-ref cache dir
 *    (`${WORKSPACE_DIR}/.lobu-cache/sources/<uri-hash>/refs/<ref>/`),
 *    sealing each file's sha256 during the copy so the manifest's hashes
 *    record exactly the bytes that landed in the cache. The returned
 *    Snapshot reads from that locked, read-only per-ref dir — never the
 *    live source — so `snapshot.ref` always agrees with
 *    `snapshot.readFile(path)` even under concurrent writes against the
 *    source.
 *  - `ref` is the canonical manifest hash (sha256 of sorted `(path, sha256)`
 *    pairs).
 *  - `diffSinceRef(prevRef)`: re-walks the live directory, builds a fresh
 *    manifest, and diffs it against the stored per-ref manifest that
 *    matches `prevRef`. If no stored manifest matches (cache was cleared
 *    between runs), the diff treats every current file as `added`.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
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
      //  2. For each file: stream-pipe the source bytes through a sha256 hash
      //     AND into a staging copy in a single pass. The per-file hash is
      //     SEALED at copy time — the bytes that landed in staging are
      //     identical to the bytes the hash was computed over, and there is
      //     no second pass over staging that could observe a post-copy
      //     mutation.
      //  3. Staging lives INSIDE the cache root at
      //     `${root}/refs/<crypto-random-32hex>` — same filesystem as the
      //     destination per-ref dir, so `rename()` is atomic and never
      //     throws EXDEV on Linux hosts where `os.tmpdir()` is a separate
      //     `tmpfs` mount. The directory name is a 128-bit crypto-random
      //     hex string with no fixed prefix, so an external `readdir` of
      //     `refs/` cannot distinguish in-flight staging (32-hex) from
      //     completed per-ref dirs (64-hex sha256) without inspecting
      //     each entry — both look like opaque hex blobs.
      //  4. Compute the canonical ref from the sealed per-file hashes.
      //  5. If `refs/<ref>` already exists, drop staging; else rename staging
      //     into the per-ref dir. After rename, chmod every file to 0400 and
      //     the dir tree to 0500 so post-rename mutation through the per-ref
      //     dir gets EACCES.
      //
      // The Snapshot reads from the per-ref dir — never from the live source
      // and never from a writable staging dir — so `snapshot.ref` matches
      // `sha256(snapshot.readFile(path))` for every tracked path no matter
      // what races happen on the source filesystem.
      const relPaths = await listRelativeFiles(this.#rootDir, this.#exclude);
      await mkdir(join(this.#paths.root, 'refs'), { recursive: true });
      const stagingDir = join(this.#paths.root, 'refs', randomBytes(16).toString('hex'));
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      let stagingMoved = false;
      let refDir: string;
      let files: ManifestEntry[];
      let ref: string;
      try {
        files = await streamCopyAndHash(this.#rootDir, stagingDir, relPaths);
        ref = canonicalManifestRef(files);
        refDir = perRefDir(this.#paths.root, ref);
        if (await dirExists(refDir)) {
          // Same content already installed; throw away the staging copy.
          await rm(stagingDir, { recursive: true, force: true });
          stagingMoved = true;
        } else {
          await rename(stagingDir, refDir);
          stagingMoved = true;
          // Lock the per-ref tree read-only AFTER rename. Any post-rename
          // write through the per-ref dir path now gets EACCES — so the
          // bytes a Snapshot reads can't drift from the sealed manifest.
          await lockTreeReadOnly(refDir);
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
      // distinct content state if the source is rewritten. Always preserve
      // the just-returned dir (`refDir`), including the cache-hit branch
      // where its mtime is older than newer entries — pruning it would
      // ENOENT the Snapshot we just handed back. Mirrors the
      // `protectedRefDir` argument tarball-file-source.ts already uses.
      await pruneOldRefDirs(this.#paths.root, MAX_REF_DIRS, refDir);

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
 * Stream-copy each tracked file from `sourceRoot` into `stagingDir`, feeding
 * the bytes through a sha256 hasher in the same pass. Per-file hash is
 * SEALED at copy time — the manifest entry records exactly the bytes that
 * were written into staging. There is no second pass over staging that
 * could observe a post-copy mutation.
 *
 * Why streaming instead of copy-on-write + post-hash: COW (`COPYFILE_FICLONE`)
 * shares pages with the source until either side writes; a concurrent
 * truncate-and-rewrite on the source breaks the share and may race the
 * hash pass. A read-then-hash-then-write streaming pipe seals the bytes
 * the instant they leave the source.
 */
async function streamCopyAndHash(
  sourceRoot: string,
  stagingDir: string,
  relPaths: string[],
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  for (const rel of relPaths) {
    const src = join(sourceRoot, rel);
    const dst = join(stagingDir, rel);
    await mkdir(dirname(dst), { recursive: true });
    const hash = createHash('sha256');
    const reader = createReadStream(src);
    reader.on('data', (chunk) => {
      hash.update(chunk as Buffer);
    });
    await pipeline(reader, createWriteStream(dst, { mode: 0o400 }));
    out.push({ path: rel, sha256: hash.digest('hex') });
  }
  return out;
}

/**
 * Recursively chmod a freshly-installed per-ref dir to read-only:
 *   - regular files → 0400 (owner read)
 *   - directories   → 0500 (owner read+execute, no write)
 *
 * Locks ordering: chmod files first, dirs after — once a dir is 0500 you
 * can still read its contents but can't add or rename entries inside it.
 * That ordering means each file is locked before its parent dir, which is
 * harmless either way; do it for symmetry with the unlock path used by
 * `pruneOldRefDirs`.
 */
async function lockTreeReadOnly(root: string): Promise<void> {
  // Two-pass walk: collect everything first, then chmod files then dirs.
  // We can't rely on walkDirectoryRelative to yield dirs, so do a manual
  // depth-first walk and track both.
  const files: string[] = [];
  const dirs: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        dirs.push(abs);
        await walk(abs);
      } else if (ent.isFile()) {
        files.push(abs);
      }
    }
  }
  await walk(root);
  for (const f of files) await chmod(f, 0o400).catch(() => undefined);
  for (const d of dirs) await chmod(d, 0o500).catch(() => undefined);
  await chmod(root, 0o500).catch(() => undefined);
}

/**
 * Reverse `lockTreeReadOnly` so `rm -rf` can delete the tree. Restores
 * write permission to the owner on every dir + file, depth-first so we
 * never try to descend into a still-locked directory.
 */
async function unlockTree(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await chmod(abs, 0o700).catch(() => undefined);
        await walk(abs);
      } else if (ent.isFile()) {
        await chmod(abs, 0o600).catch(() => undefined);
      }
    }
  }
  await walk(root);
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
 * Keep at most `keep` per-ref directories under `${root}/refs/`. Sorted by
 * mtime descending; the oldest are rm-rf'd. `protectedRefDir` is always
 * preserved regardless of mtime — the cache-hit branch in fetch() returns
 * an existing dir whose mtime may be older than newer entries, and the
 * Snapshot we just handed back is reading from it. Pre-this-guard, the
 * mtime sort happily pruned exactly the dir the caller was about to read,
 * leaving the Snapshot pointing at an ENOENT. Matches the
 * `protectedRefDir` parameter tarball-file-source.ts already uses
 * (lines 137 + 228-273).
 *
 * Per-ref dirs are locked read-only (0500) after install, so `rm -rf`
 * would EACCES on them; unlock before remove. Snapshots already handed
 * out keep working as long as their backing dir wasn't pruned —
 * `keep=3` accommodates a fresh fetch plus two in-flight overlapping
 * syncs.
 *
 * Filters by name shape (64-hex sha256). Skips in-flight staging dirs
 * (32-hex random names co-located in `refs/`) AND any legacy `.staging.*`
 * directories from older builds. Per-ref manifest JSON files
 * (`<ref>.json`) are files, not directories, and are kept indefinitely
 * so historical diffs work even after the data dir is gone.
 */
async function pruneOldRefDirs(
  root: string,
  keep: number,
  protectedRefDir: string,
): Promise<void> {
  const refsRoot = join(root, 'refs');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(refsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const candidates: Array<{
    name: string;
    abs: string;
    mtimeMs: number;
    protected: boolean;
  }> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // Only touch completed per-ref dirs (64-hex sha256). In-flight staging
    // dirs use a 32-hex randomBytes name and must not be pruned.
    if (!/^[a-f0-9]{64}$/.test(ent.name)) continue;
    const abs = join(refsRoot, ent.name);
    try {
      const s = await stat(abs);
      candidates.push({
        name: ent.name,
        abs,
        mtimeMs: s.mtimeMs,
        protected: abs === protectedRefDir,
      });
    } catch {
      // Skip — concurrent prune from another process is fine.
    }
  }
  if (candidates.length <= keep) return;
  const protectedDirs = candidates.filter((c) => c.protected);
  const others = candidates
    .filter((c) => !c.protected)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepers = new Set([
    ...protectedDirs.map((c) => c.name),
    ...others.slice(0, Math.max(0, keep - protectedDirs.length)).map((c) => c.name),
  ]);
  for (const c of candidates) {
    if (keepers.has(c.name)) continue;
    // Unlock the read-only tree first; rm -rf would EACCES on dirs in
    // mode 0500.
    await unlockTree(c.abs).catch(() => undefined);
    await rm(c.abs, { recursive: true, force: true }).catch(() => undefined);
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
