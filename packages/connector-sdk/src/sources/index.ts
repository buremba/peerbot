/**
 * Filesystem-shape ingestion sources: `@lobu/connector-sdk/sources`.
 *
 * Git, tarball and local-directory sources need `node:fs`, `node:https` and
 * `isomorphic-git`, so they live behind this subpath rather than the package
 * root, which must stay loadable inside a V8 isolate. The `FileSystemSource`,
 * `Snapshot` and `FileDelta` TYPES stay exported from the root so a connector
 * can accept a source without importing the implementations.
 */
export type { FileDelta, FileSystemSource, Snapshot } from '../file-source.js';
export { fileSystemSourceFromUri } from '../file-source.js';
export { GitFileSource, parseGitUri } from './git-file-source.js';
export type { TarballFileSourceOptions } from './tarball-file-source.js';
export { TarballFileSource } from './tarball-file-source.js';
export { LocalFileSource } from './local-file-source.js';
