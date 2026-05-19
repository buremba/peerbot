/**
 * TarballFileSource — download a remote `.tar.gz`/`.tgz`, extract once,
 * snapshot from the extraction directory.
 *
 *  - Download via `undici.request` (Node built-in, no extra dep).
 *  - Extract via `tar` (npm `tar`, ~50KB) — streaming, won't buffer the
 *    archive in memory.
 *  - Atomic install: extract to `${root}/snapshot.tmp.<rand>` and rename
 *    over `${root}/snapshot/` once extraction completes. Partial fetches
 *    don't corrupt the cache.
 *  - `ref` is the canonical manifest hash; identical content → identical
 *    `ref` regardless of when/where it was fetched.
 *  - `diffSinceRef` re-fetches and compares against the per-ref manifest
 *    stored alongside the cache. Full tarballs have no incremental wire
 *    support — the gain is "did anything change?" not "send me the delta".
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as tarExtract } from 'tar';

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
  requireMeta,
  withSourceLock,
  writeManifest,
  writeMeta,
} from './cache.js';
import { walkDirectoryRelative } from './glob.js';
import { DirectorySnapshot } from './snapshot.js';

export interface TarballFileSourceOptions {
  /** Strip the leading directory component during extraction (default 0). */
  stripComponents?: number;
}

export class TarballFileSource implements FileSystemSource {
  readonly #uri: string;
  readonly #paths: CachePaths;
  readonly #stripComponents: number;

  constructor(uri: string, opts: TarballFileSourceOptions = {}) {
    if (uri.startsWith('http://')) {
      throw new Error('TarballFileSource: plaintext HTTP rejected, use https://');
    }
    if (!uri.startsWith('https://')) {
      throw new Error(`TarballFileSource: expected https:// URI, got ${uri}`);
    }
    const lower = uri.split('?')[0]?.split('#')[0] ?? uri;
    if (!lower.endsWith('.tar.gz') && !lower.endsWith('.tgz')) {
      throw new Error(`TarballFileSource: only .tar.gz / .tgz supported in v1 (${uri})`);
    }
    this.#uri = uri;
    this.#paths = cachePathsFor(uri);
    this.#stripComponents = opts.stripComponents ?? 0;
  }

  fetch(): Promise<Snapshot> {
    return withSourceLock(this.#uri, () => this.#fetchLocked());
  }

  async #fetchLocked(): Promise<Snapshot> {
    await mkdir(this.#paths.root, { recursive: true });
    await readAndVerifyMeta(this.#paths.metaPath, this.#uri);

    // 1. Download to temp file (streaming).
    const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-tarball-'));
    const tarPath = join(tmpDir, 'archive.tar.gz');
    try {
      // Use Node's built-in fetch — handles redirects + streaming bodies.
      const res = await fetch(this.#uri, { redirect: 'follow' });
      if (!res.ok) {
        throw new Error(
          `TarballFileSource: GET ${this.#uri} returned ${res.status}`,
        );
      }
      if (!res.body) {
        throw new Error(`TarballFileSource: GET ${this.#uri} returned an empty body`);
      }
      // Soft Content-Type check — accept tarball-ish or generic binary.
      // Some CDNs return text/plain; don't reject on that, just continue and
      // let tar's parser surface a malformed-input error if it isn't a tarball.
      void res.headers.get('content-type');

      // Web ReadableStream -> Node Readable for pipeline().
      const nodeBody = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeBody, createWriteStream(tarPath));

      // 2. Extract to a temp staging dir, atomic-rename into place.
      const stagingDir = join(this.#paths.root, `snapshot.tmp.${randomSuffix()}`);
      await mkdir(stagingDir, { recursive: true });
      await tarExtract({
        file: tarPath,
        cwd: stagingDir,
        strip: this.#stripComponents,
      });

      // Remove any previous snapshot, then rename.
      await rm(this.#paths.snapshotDir, { recursive: true, force: true });
      await rename(stagingDir, this.#paths.snapshotDir);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    // 3. Build manifest from extracted files.
    const files = await collectFiles(this.#paths.snapshotDir);
    const ref = canonicalManifestRef(files);
    const manifest: Manifest = {
      ref,
      files,
      fetched_at: new Date().toISOString(),
    };
    await writeManifest(this.#paths.manifestPath, manifest);
    await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'tarball' });
    await writePerRefManifest(this.#paths.root, manifest);

    return new DirectorySnapshot(this.#paths.snapshotDir, ref);
  }

  async diffSinceRef(prevRef: string): Promise<FileDelta> {
    // Re-fetch (no incremental wire support), then diff manifests.
    // fetch() takes the lock itself; nest a separate read step outside it.
    const snapshot = await this.fetch();
    if (snapshot.ref === prevRef) return { added: [], modified: [], removed: [] };

    return withSourceLock(this.#uri, async () => {
      await requireMeta(this.#paths.metaPath, this.#uri);
      const prev = await readPerRefManifest(this.#paths.root, prevRef);
      const next = await readManifest(this.#paths.manifestPath);
      if (!next) throw new Error('TarballFileSource: manifest disappeared after fetch');

      if (!prev) {
        // We don't have the prior manifest — treat everything as new.
        return { added: next.files.map((f) => f.path), modified: [], removed: [] };
      }
      return diffManifests(prev, next);
    });
  }
}

async function collectFiles(rootDir: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  // Ensure dir exists; a 0-file archive should produce an empty manifest, not throw.
  const s = await stat(rootDir).catch(() => null);
  if (!s) return out;
  for await (const rel of walkDirectoryRelative(rootDir)) {
    const abs = join(rootDir, rel);
    const buf = await readFile(abs);
    const sha = createHash('sha256').update(buf).digest('hex');
    out.push({ path: rel, sha256: sha });
  }
  return out;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function writePerRefManifest(root: string, manifest: Manifest): Promise<void> {
  await mkdir(join(root, 'refs'), { recursive: true });
  await writeManifest(join(root, 'refs', `${manifest.ref}.json`), manifest);
}

async function readPerRefManifest(root: string, ref: string): Promise<Manifest | null> {
  return readManifest(join(root, 'refs', `${ref}.json`));
}
