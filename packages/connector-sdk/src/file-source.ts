/**
 * FileSystemSource — reusable primitive for connectors that ingest from
 * a directory-tree-shaped source (git repos, tarballs, local pre-staged data).
 *
 * Design notes (kept tight so the contract stays small):
 *
 *  - The connector NEVER sees on-disk paths. Snapshot exposes `walkFiles`,
 *    `readFile`, and `readText` — that's the entire surface. Internally the
 *    SDK manages a cache rooted at `${WORKSPACE_DIR}/.lobu-cache/sources/<h>`
 *    but that's opaque.
 *
 *  - `ref` is an opaque identifier (commit SHA for git, manifest hash for
 *    tarball / local). Connectors persist it in their checkpoint and pass
 *    it back via `diffSinceRef` next run.
 *
 *  - Sources NOT in scope for v1: photos / WhatsApp / Gmail / Slack-style
 *    feeds. Those have source-specific cursors and stay bespoke.
 */

/**
 * A view over a filesystem-shaped data source.
 *
 * Implementations expose file access only — `rootDir` is intentionally
 * hidden so connectors can't accidentally couple to the on-disk layout.
 *
 * Lifecycle / mutability contract (important):
 *
 *  - The bytes returned by `readFile` / `readText` reflect the state of the
 *    cache at the moment `fetch()` returned. `snap.ref` is a deterministic
 *    hash of those bytes, sealed during the stream-copy from source into
 *    the per-ref cache dir.
 *  - The SDK does NOT protect the cache against same-UID writes. The worker
 *    process owns the cache, and we don't fight our own UID — chmod 0500
 *    would just be re-mode'd away by an attacker running as the same user.
 *    If a hostile connector (or external same-UID process) mutates the
 *    per-ref dir after fetch returns, `readFile` will return mutated bytes
 *    while `snap.ref` still reflects the bytes captured at fetch time.
 *    Connectors should treat their own cache as trusted.
 *  - Cross-process readers sharing the same cache see the same per-ref
 *    dir contents. Pruning is process-local (an in-memory `Promise`
 *    mutex per URI); concurrent processes can race-prune each other's
 *    protected refs. v1 supports one cache owner per workspace —
 *    multi-process sharing would need a filesystem advisory lock.
 *  - A Snapshot is a *cursor* over the SDK-managed cache for one URI, not
 *    a content-addressed copy in your possession. The SDK serializes
 *    concurrent `fetch()` calls on a single source within one process;
 *    the per-ref dir the Snapshot points at is kept alive through prune
 *    (`MAX_REF_DIRS` >= 3 accommodates a fresh fetch plus two in-flight
 *    overlapping syncs), but if you park a Snapshot long enough that 3+
 *    subsequent distinct fetches roll past it, its backing dir may have
 *    been pruned.
 *  - `ref` always reflects the on-disk content at the moment `fetch()`
 *    returned — pin it in the connector checkpoint to detect mutation later.
 */
export interface Snapshot {
  /** Opaque identifier — commit SHA for git, manifest hash for tarball/local. */
  readonly ref: string;
  /** Iterate relative paths that match `glob` (POSIX-style, e.g. `"docs/**\/*.md"`). */
  walkFiles(glob: string): AsyncIterable<string>;
  /** Read a file by relative path. Throws if it does not exist. */
  readFile(relativePath: string): Promise<Buffer>;
  /** Read a file as UTF-8 text. Throws if it does not exist. */
  readText(relativePath: string): Promise<string>;
}

/**
 * File-level delta between two snapshots of the same source.
 *
 * Paths are relative, deterministic order is not guaranteed.
 */
export interface FileDelta {
  added: string[];
  modified: string[];
  removed: string[];
}

/**
 * A reusable filesystem-shape source. `fetch()` populates / refreshes a
 * local cache and yields a Snapshot; `diffSinceRef()` reports what changed
 * since a previously-recorded ref.
 */
export interface FileSystemSource {
  /** Fetch (or refetch) to a local cache; returns the snapshot. Idempotent. */
  fetch(): Promise<Snapshot>;
  /**
   * File-level delta against a prior ref.
   *
   * Contract (all implementations behave the same way):
   *  - `prevRef === currentRef` → empty delta.
   *  - `prevRef` is recognised (manifest on disk for tarball/local; commit
   *    reachable in the shallow clone for git) → real `(added, modified,
   *    removed)` lists.
   *  - `prevRef` is NOT recognised → full-reingest delta: every currently
   *    present file appears in `added`. Connectors are expected to be
   *    idempotent at the event-id layer, so a re-ingest is safe.
   *  - The source has never been `fetch()`ed → throws. Call `fetch()` first.
   */
  diffSinceRef(prevRef: string): Promise<FileDelta>;
}

/**
 * Resolve a URI to a concrete FileSystemSource. Throws on unknown schemes.
 *
 * Supported URI shapes:
 *  - `git+https://github.com/owner/repo.git@<ref>`  (ref optional, defaults to `main`)
 *  - `https://example.com/dataset.tar.gz`            (or `.tgz`)
 *  - `file:///absolute/path/`
 *
 * Rejected (clear error messages):
 *  - `git+ssh://`, `ssh://` — SSH auth needs operator keys; out of scope for v1.
 *  - `git+http://`, `http://` tarballs — only HTTPS for v1.
 *  - `s3://`, `gs://`, `azure://`, etc. — reserved for future schemes.
 *  - Non-tarball HTTPS URLs (`.zip`, etc.) — only `.tar.gz`/`.tgz` for v1.
 */
export function fileSystemSourceFromUri(uri: string): FileSystemSource {
  // Implementation in source resolver; this is the public entry point.
  return resolveUri(uri);
}

// Lazy import-time wiring lives in `./sources/resolver.ts` so the three
// concrete implementations can stay isolated and tree-shake cleanly.
import { resolveUri } from './sources/resolver.js';
