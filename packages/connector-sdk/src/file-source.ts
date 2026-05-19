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
 *  - A Snapshot is a *cursor* over the SDK-managed cache for one URI, not a
 *    content-addressed copy. Two snapshots of the same source share one
 *    on-disk directory. Calling `fetch()` again will mutate that directory.
 *  - Connectors MUST consume a snapshot fully (walk + read) before calling
 *    `fetch()` again on the same source — concretely: don't park a Snapshot
 *    in a queue and re-`fetch()` in another task expecting both views to
 *    remain readable. The SDK serializes concurrent `fetch()` calls on a
 *    single source, but reads against a stale snapshot once a new fetch has
 *    completed will return current-on-disk bytes, not historical bytes.
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
  /** File-level delta against a prior ref. Empty if `prevRef === currentRef`. */
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
