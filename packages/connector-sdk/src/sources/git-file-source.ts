/**
 * GitFileSource — shallow git clone backed by `isomorphic-git`.
 *
 *  - URI shape: `git+https://github.com/owner/repo.git[@<ref>]`. Ref may be
 *    a branch name, tag, or full commit SHA. If omitted, defaults to `main`.
 *  - Initial fetch: shallow clone (`depth: 1`, `singleBranch: true`).
 *  - Subsequent fetch: `git.fetch` against the same single branch with
 *    `depth: 1` — pulls only the new tip if upstream advanced.
 *  - `ref` = `resolveRef('HEAD')` (full commit SHA).
 *  - `diffSinceRef(prevRef)` walks two trees with `git.walk` and classifies
 *    each path by OID equality (`added`/`modified`/`removed`).
 *
 * Caveats called out in JSDoc rather than hidden:
 *
 *  - With `depth: 1`, history before the current tip is NOT in the local
 *    repo. `git.walk` requires both trees to be reachable; if the caller
 *    passes a `prevRef` we no longer have on disk we throw a clear error.
 *  - Snapshot reads point at the working tree inside the cache. Git itself
 *    is not exposed.
 */

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
// `fs` is passed as a plain Node fs module — isomorphic-git accepts it.
// We import the callback-style module so isomorphic-git's promisified
// adapter works out of the box (it auto-detects promises if present).
import nodeFs from 'node:fs';

import type { FileDelta, FileSystemSource, Snapshot } from '../file-source.js';
import {
  type CachePaths,
  cachePathsFor,
  readAndVerifyMeta,
  requireMeta,
  withSourceLock,
  writeMeta,
} from './cache.js';
import { GitSnapshot } from './git-snapshot.js';
// Custom https-only http client — rejects plaintext redirects that the
// stock `isomorphic-git/http/node` (simple-get under the hood) would
// silently follow.
import { gitHttpsOnlyClient as http } from './git-http.js';

const DEFAULT_BRANCH = 'main';

export interface ParsedGitUri {
  url: string;
  ref: string;
}

export function parseGitUri(uri: string): ParsedGitUri {
  if (uri.startsWith('git+http://')) {
    throw new Error('GitFileSource: plaintext HTTP rejected, use git+https://');
  }
  if (!uri.startsWith('git+https://')) {
    throw new Error(`GitFileSource: expected git+https:// URI, got ${uri}`);
  }
  const stripped = uri.slice('git+'.length); // → https://...
  // Split on the LAST `@` that follows the host's `/`, not the user@host form.
  const slashIdx = stripped.indexOf('/', stripped.indexOf('://') + 3);
  const atIdx = slashIdx === -1 ? -1 : stripped.lastIndexOf('@');
  if (atIdx > slashIdx) {
    return {
      url: stripped.slice(0, atIdx),
      ref: stripped.slice(atIdx + 1) || DEFAULT_BRANCH,
    };
  }
  return { url: stripped, ref: DEFAULT_BRANCH };
}

export class GitFileSource implements FileSystemSource {
  readonly #uri: string;
  readonly #parsed: ParsedGitUri;
  readonly #paths: CachePaths;

  constructor(uri: string) {
    this.#uri = uri;
    this.#parsed = parseGitUri(uri);
    this.#paths = cachePathsFor(uri);
  }

  fetch(): Promise<Snapshot> {
    return withSourceLock(this.#uri, () => this.#fetchLocked());
  }

  async #fetchLocked(): Promise<Snapshot> {
    await mkdir(this.#paths.root, { recursive: true });
    await readAndVerifyMeta(this.#paths.metaPath, this.#uri);
    const dir = this.#paths.snapshotDir;

    // Detect whether we already have a clone.
    const alreadyCloned = await pathExists(join(dir, '.git'));

    if (!alreadyCloned) {
      await mkdir(dir, { recursive: true });
      await git.clone({
        fs: nodeFs,
        http,
        dir,
        url: this.#parsed.url,
        ref: this.#parsed.ref,
        singleBranch: true,
        depth: 1,
      });
    } else {
      // Existing repo — fetch the same branch shallow.
      await git.fetch({
        fs: nodeFs,
        http,
        dir,
        ref: this.#parsed.ref,
        singleBranch: true,
        depth: 1,
        tags: false,
      });
      // Move HEAD/working tree to the fetched tip.
      await git.checkout({
        fs: nodeFs,
        dir,
        ref: this.#parsed.ref,
        force: true,
      });
    }

    const ref = await git.resolveRef({ fs: nodeFs, dir, ref: 'HEAD' });
    await writeMeta(this.#paths.metaPath, { uri: this.#uri, kind: 'git' });

    // Read from the captured commit's tree/blobs — immutable view even if a
    // later fetch() moves HEAD or rewrites the working tree on disk.
    return new GitSnapshot(dir, ref, nodeFs, { exclude: isGitInternalPath });
  }

  diffSinceRef(prevRef: string): Promise<FileDelta> {
    return withSourceLock(this.#uri, () => this.#diffLocked(prevRef));
  }

  async #diffLocked(prevRef: string): Promise<FileDelta> {
    await requireMeta(this.#paths.metaPath, this.#uri);
    const dir = this.#paths.snapshotDir;
    const currentRef = await git.resolveRef({ fs: nodeFs, dir, ref: 'HEAD' });
    if (currentRef === prevRef) return { added: [], modified: [], removed: [] };

    // If `prevRef` isn't reachable in the local (shallow) repo, return a
    // full-reingest delta — every current file as `added`. Matches the
    // tarball and local-source contract: an unknown prevRef yields a
    // re-ingest, never a thrown error.
    let prevReachable = true;
    try {
      await git.readCommit({ fs: nodeFs, dir, oid: prevRef });
    } catch {
      prevReachable = false;
    }
    if (!prevReachable) {
      const allFiles = await listCurrentFiles(dir, currentRef);
      return { added: allFiles, modified: [], removed: [] };
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    await git.walk({
      fs: nodeFs,
      dir,
      trees: [git.TREE({ ref: prevRef }), git.TREE({ ref: currentRef })],
      map: async (filepath, entries) => {
        // The root entry has filepath '.'. Don't classify it but DO let the
        // walk descend (returning null prunes the subtree).
        if (filepath === '.') return undefined;
        if (!entries) return undefined;
        const [a, b] = entries;

        // Skip directories — they're emitted as their own map() calls; we
        // only classify file (blob) entries.
        const aType = a ? await a.type() : null;
        const bType = b ? await b.type() : null;
        if (aType === 'tree' || bType === 'tree') return undefined;

        const aOid = aType ? await a!.oid() : null;
        const bOid = bType ? await b!.oid() : null;

        if (aOid === null && bOid !== null) added.push(filepath);
        else if (aOid !== null && bOid === null) removed.push(filepath);
        else if (aOid !== null && bOid !== null && aOid !== bOid) modified.push(filepath);

        return undefined;
      },
    });

    return { added, modified, removed };
  }
}

/** Walk a commit's tree and return every blob path (POSIX-separated). */
async function listCurrentFiles(dir: string, ref: string): Promise<string[]> {
  const collected: string[] = [];
  await git.walk({
    fs: nodeFs,
    dir,
    trees: [git.TREE({ ref })],
    map: async (filepath, entries) => {
      if (filepath === '.') return undefined;
      if (!entries) return undefined;
      const [entry] = entries;
      if (!entry) return undefined;
      const type = await entry.type();
      if (type === 'blob') collected.push(filepath);
      return undefined;
    },
  });
  return collected;
}

/** Filter for git internals — matches `.git` itself and anything under it. */
function isGitInternalPath(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
