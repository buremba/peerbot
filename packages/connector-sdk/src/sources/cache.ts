/**
 * Cache-layout helpers shared by all FileSystemSource implementations.
 *
 *   ${WORKSPACE_DIR}/.lobu-cache/sources/<sha256(uri)[:32]>/
 *     ├── snapshot/        ← actual files (connector-visible via Snapshot.readFile)
 *     ├── manifest.json    ← { ref, files: [{ path, sha256 }], fetched_at }
 *     └── meta.json        ← { uri, kind }
 *
 *  - `WORKSPACE_DIR` env var is the cache root; falls back to `process.cwd()`.
 *  - URI is hashed (sha256, first 32 hex chars = 128 bits) for filesystem-safe
 *    naming. 128 bits is collision-resistant even against adversarial URIs
 *    (1e19 URIs before 50% collision odds).
 *  - One cache directory per URI — same URI yields the same directory across
 *    runs so re-fetch is incremental for git, manifest-comparable for the rest.
 *    On reuse, `meta.json`'s `uri` field is verified to match — a mismatch
 *    (theoretical hash collision OR cache-root reuse across schemes) throws.
 *  - The cache layout is intentionally NOT exported on the public API; this
 *    module is internal to the SDK.
 */

import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SourceKind = 'git' | 'tarball' | 'local';

export interface ManifestEntry {
  path: string;
  sha256: string;
}

export interface Manifest {
  ref: string;
  files: ManifestEntry[];
  fetched_at: string;
}

export interface CacheMeta {
  uri: string;
  kind: SourceKind;
}

export interface CachePaths {
  /** Absolute cache root for this URI. */
  readonly root: string;
  /** Where the source's files live (rootDir of the Snapshot). */
  readonly snapshotDir: string;
  /** manifest.json path. */
  readonly manifestPath: string;
  /** meta.json path. */
  readonly metaPath: string;
}

/** Build the cache paths for `uri`, anchored under `cacheRoot`. */
export function cachePathsFor(uri: string, cacheRoot: string = defaultCacheRoot()): CachePaths {
  const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
  const root = join(cacheRoot, '.lobu-cache', 'sources', hash);
  return {
    root,
    snapshotDir: join(root, 'snapshot'),
    manifestPath: join(root, 'manifest.json'),
    metaPath: join(root, 'meta.json'),
  };
}

/**
 * Read `meta.json` if present and assert it matches `uri`. Throws on URI
 * mismatch (defends against an adversarial collision OR an operator copying
 * a cache dir across sources). Returns `null` for a fresh cache.
 */
export async function readAndVerifyMeta(
  metaPath: string,
  expectedUri: string,
): Promise<CacheMeta | null> {
  const meta = await readMeta(metaPath);
  if (!meta) return null;
  if (meta.uri !== expectedUri) {
    throw new Error(
      `FileSystemSource cache mismatch: ${metaPath} belongs to ${meta.uri}, ` +
        `but ${expectedUri} was requested. Refusing to reuse cache directory.`,
    );
  }
  return meta;
}

/**
 * Like `readAndVerifyMeta`, but rejects when the cache is uninitialised.
 * Use this from `diffSinceRef()` paths — calling diff before fetch is a
 * caller bug, and a missing meta also means a stale/collided cache dir
 * should not be silently consumed.
 */
export async function requireMeta(metaPath: string, expectedUri: string): Promise<CacheMeta> {
  const meta = await readAndVerifyMeta(metaPath, expectedUri);
  if (!meta) {
    throw new Error(
      `FileSystemSource: source not fetched yet — call fetch() before diffSinceRef() (${expectedUri})`,
    );
  }
  return meta;
}

/**
 * Per-source mutex. Same URI → shared `Promise` chain so concurrent
 * `fetch()` calls serialize. Process-local only — fine for the embedded
 * worker model where one worker subprocess owns its cache.
 *
 * v1 limitation: two processes sharing the same
 * `${WORKSPACE_DIR}/.lobu-cache` are NOT coordinated by this lock —
 * each gets its own in-memory `_sourceLocks` map, and they can
 * race-prune each other's per-ref dirs (see `pruneOldRefDirs` in each
 * source impl). v1 assumes one cache owner per workspace. If we ever
 * need multi-process sharing, replace this with a filesystem advisory
 * lock (e.g. `proper-lockfile` against `${root}/.lock`) around
 * fetch+prune.
 *
 * The map stores the *guarded* (error-swallowed) promise so a rejection in
 * `fn` doesn't poison the chain. Identity comparison in `finally` uses the
 * same stored reference, so cleanup actually removes the entry — an
 * earlier draft created a fresh `.catch()` inside `finally` and leaked one
 * entry per distinct URI.
 */
const _sourceLocks = new Map<string, Promise<unknown>>();
export async function withSourceLock<T>(uri: string, fn: () => Promise<T>): Promise<T> {
  const prev = _sourceLocks.get(uri) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guarded = next.catch(() => undefined);
  _sourceLocks.set(uri, guarded);
  try {
    return await next;
  } finally {
    if (_sourceLocks.get(uri) === guarded) {
      _sourceLocks.delete(uri);
    }
  }
}

/** Default cache root: `WORKSPACE_DIR` env, else `process.cwd()`. */
export function defaultCacheRoot(): string {
  return process.env.WORKSPACE_DIR ?? process.cwd();
}

export async function readManifest(path: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8');
}

export async function readMeta(path: string): Promise<CacheMeta | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as CacheMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeMeta(path: string, meta: CacheMeta): Promise<void> {
  await writeFile(path, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Diff two manifests by `(path, sha256)`. Order-independent.
 */
export function diffManifests(
  prev: Manifest,
  next: Manifest,
): { added: string[]; modified: string[]; removed: string[] } {
  const prevMap = new Map(prev.files.map((f) => [f.path, f.sha256]));
  const nextMap = new Map(next.files.map((f) => [f.path, f.sha256]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, sha] of nextMap) {
    const prevSha = prevMap.get(path);
    if (prevSha === undefined) added.push(path);
    else if (prevSha !== sha) modified.push(path);
  }
  for (const path of prevMap.keys()) {
    if (!nextMap.has(path)) removed.push(path);
  }
  return { added, modified, removed };
}

/**
 * Canonicalize a manifest's `ref` from its file list:
 *
 *  sha256 over lines of `<path>\0<sha256>\n`, sorted by path.
 *
 * Deterministic across runs and platforms.
 */
export function canonicalManifestRef(files: ManifestEntry[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) {
    h.update(f.path);
    h.update('\0');
    h.update(f.sha256);
    h.update('\n');
  }
  return h.digest('hex');
}

export async function dirExists(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isDirectory();
}

/**
 * Persist a per-ref copy of `manifest` under `<root>/refs/<ref>.json`.
 * Lets `diffSinceRef` look up prior refs even after a data dir is pruned.
 */
export async function writePerRefManifest(root: string, manifest: Manifest): Promise<void> {
  await mkdir(join(root, 'refs'), { recursive: true });
  await writeManifest(join(root, 'refs', `${manifest.ref}.json`), manifest);
}

export async function readPerRefManifest(root: string, ref: string): Promise<Manifest | null> {
  return readManifest(join(root, 'refs', `${ref}.json`));
}

/** Max number of `refs/<hash>` per-ref directories kept on disk. */
export const MAX_REF_DIRS = 3;

/**
 * Keep at most `keep` per-ref directories under `${root}/refs/`. Sorted by
 * mtime descending; the oldest are rm-rf'd. `protectedRefDir` is always
 * preserved regardless of mtime.
 *
 * `isCandidateDir` filters which directory names are eligible for pruning.
 * Pass a predicate that matches only completed ref dirs (e.g. 64-hex for
 * local/tarball sources) to avoid touching in-flight staging dirs.
 * Directories that don't match are skipped silently.
 *
 * Per-ref manifest JSON files (`<ref>.json`) are files, not directories,
 * and are kept indefinitely so historical diffs work after a data dir is gone.
 */
export async function pruneOldRefDirs(
  root: string,
  keep: number,
  protectedRefDir: string,
  isCandidateDir: (name: string) => boolean = () => true,
): Promise<void> {
  const refsRoot = join(root, 'refs');
  let entries: Dirent[];
  try {
    entries = await readdir(refsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const candidates: Array<{ name: string; abs: string; mtimeMs: number; protected: boolean }> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!isCandidateDir(ent.name)) continue;
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
    await rm(c.abs, { recursive: true, force: true }).catch(() => undefined);
  }
}
