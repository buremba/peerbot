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
  MAX_REF_DIRS,
  canonicalManifestRef,
  cachePathsFor,
  diffManifests,
  dirExists,
  pruneOldRefDirs,
  readAndVerifyMeta,
  readManifest,
  readPerRefManifest,
  requireMeta,
  withSourceLock,
  writeManifest,
  writeMeta,
  writePerRefManifest,
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

    // 1. Download to temp file (streaming) + extract to a staging dir.
    const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-tarball-'));
    const tarPath = join(tmpDir, 'archive.tar.gz');
    const stagingDir = join(this.#paths.root, `snapshot.tmp.${randomSuffix()}`);
    let stagingMoved = false;
    try {
      const res = await httpsFetchNoDowngrade(this.#uri);
      if (!res.ok) {
        throw new Error(
          `TarballFileSource: GET ${this.#uri} returned ${res.status}`,
        );
      }
      if (!res.body) {
        throw new Error(`TarballFileSource: GET ${this.#uri} returned an empty body`);
      }
      const nodeBody = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeBody, createWriteStream(tarPath));

      await mkdir(stagingDir, { recursive: true });
      await tarExtract({
        file: tarPath,
        cwd: stagingDir,
        strip: this.#stripComponents,
      });

      // 2. Compute the content-addressed ref from the extracted files.
      const files = await collectFiles(stagingDir);
      const ref = canonicalManifestRef(files);
      const refDir = perRefSnapshotDir(this.#paths.root, ref);

      // 3. Install into the per-ref dir if it isn't already there. Old refs
      // stay on disk so any Snapshot already handed out keeps reading its
      // pinned bytes. A partial crash leaves the staging dir behind, which
      // is harmless — the next fetch() will simply re-stage.
      const alreadyInstalled = await dirExists(refDir);
      if (alreadyInstalled) {
        // Same content already installed under this ref; drop the staging dir.
        await rm(stagingDir, { recursive: true, force: true });
      } else {
        await mkdir(join(this.#paths.root, 'refs'), { recursive: true });
        await rename(stagingDir, refDir);
      }
      stagingMoved = true;

      // 4. Persist manifest + meta + per-ref manifest. (Old per-ref manifests
      // stay so historical diffs still work.)
      const manifest: Manifest = {
        ref,
        files,
        fetched_at: new Date().toISOString(),
      };
      await writeManifest(this.#paths.manifestPath, manifest);
      await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'tarball' });
      await writePerRefManifest(this.#paths.root, manifest);
      // Keep cache size bounded. We always preserve the freshly-installed
      // ref dir, so the just-returned Snapshot is safe.
      await pruneOldRefDirs(this.#paths.root, MAX_REF_DIRS, refDir, IS_REF_DIR);

      // Snapshot reads from the immutable per-ref dir — never overwritten.
      return new DirectorySnapshot(refDir, ref);
    } finally {
      if (!stagingMoved) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async diffSinceRef(prevRef: string): Promise<FileDelta> {
    // diffSinceRef before fetch() is a caller bug — pin that contract first
    // so a fresh cache throws "source not fetched yet" instead of silently
    // performing a full re-ingest via the implicit fetch() below. Matches
    // the local + git sources.
    await withSourceLock(this.#uri, async () => {
      await requireMeta(this.#paths.metaPath, this.#uri);
    });

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

function perRefSnapshotDir(root: string, ref: string): string {
  return join(root, 'refs', ref);
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

const IS_REF_DIR = (name: string): boolean => /^[a-f0-9]{64}$/.test(name);

const MAX_REDIRECTS = 5;

/**
 * fetch() with manual redirect following + an https-only guard on every hop.
 * Rejects with a clear error if any 3xx Location points at a non-https URL,
 * defending against a redirect-based plaintext downgrade.
 */
async function httpsFetchNoDowngrade(initialUrl: string): Promise<Response> {
  let url = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!url.startsWith('https://')) {
      throw new Error(`TarballFileSource: redirect to plaintext URL rejected: ${url}`);
    }
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    // 3xx — must have a Location header.
    const loc = res.headers.get('location');
    if (!loc) return res;
    // Resolve relative URLs against the current URL.
    try {
      url = new URL(loc, url).toString();
    } catch {
      throw new Error(`TarballFileSource: invalid redirect location: ${loc}`);
    }
    // Drain the body so the socket is reusable.
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
  }
  throw new Error(`TarballFileSource: too many redirects (>${MAX_REDIRECTS}) for ${initialUrl}`);
}
