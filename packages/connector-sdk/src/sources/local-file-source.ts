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

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FileDelta, FileSystemSource, Snapshot } from '../file-source.js';
import {
  type CachePaths,
  type Manifest,
  type ManifestEntry,
  canonicalManifestRef,
  cachePathsFor,
  diffManifests,
  readAndVerifyMeta,
  readManifest,
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
   * (`.lobu-cache/`) — typical when the source is the workspace root — we
   * must NOT ingest our own cache files, or every fetch() would mutate the
   * ref and self-pollute. This predicate hides them from manifest, walk,
   * and read.
   */
  readonly #exclude: (relativePath: string) => boolean;

  constructor(uri: string) {
    if (!uri.startsWith('file://')) {
      throw new Error(`LocalFileSource: expected file:// URI, got ${uri}`);
    }
    this.#uri = uri;
    this.#rootDir = fileURLToPath(uri);
    this.#paths = cachePathsFor(uri);
    this.#exclude = (rel) => rel === '.lobu-cache' || rel.startsWith('.lobu-cache/');
  }

  fetch(): Promise<Snapshot> {
    return withSourceLock(this.#uri, async () => {
      const s = await stat(this.#rootDir).catch(() => null);
      if (!s || !s.isDirectory()) {
        throw new Error(`LocalFileSource: ${this.#rootDir} is not a directory`);
      }

      // Cache root is opaque metadata only — no file copies for `file://`.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(this.#paths.root, { recursive: true });
      await readAndVerifyMeta(this.#paths.metaPath, this.#uri);

      const files = await collectFiles(this.#rootDir, this.#exclude);
      const ref = canonicalManifestRef(files);
      const manifest: Manifest = {
        ref,
        files,
        fetched_at: new Date().toISOString(),
      };

      await writeManifest(this.#paths.manifestPath, manifest);
      await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'local' });
      // Also persist a per-ref copy so diffSinceRef can look up prior refs.
      await writePerRefManifest(this.#paths.root, manifest);

      return new DirectorySnapshot(this.#rootDir, ref, { exclude: this.#exclude });
    });
  }

  diffSinceRef(prevRef: string): Promise<FileDelta> {
    return withSourceLock(this.#uri, async () => {
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
