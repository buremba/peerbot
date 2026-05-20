/**
 * URI → FileSystemSource resolver. Imported by `file-source.ts`.
 */
import type { FileSystemSource } from '../file-source.js';
import { GitFileSource } from './git-file-source.js';
import { LocalFileSource } from './local-file-source.js';
import { TarballFileSource } from './tarball-file-source.js';

export function resolveUri(uri: string): FileSystemSource {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('fileSystemSourceFromUri: uri must be a non-empty string');
  }

  // git+ssh:// — explicit reject with helpful suggestion.
  if (uri.startsWith('git+ssh://') || uri.startsWith('ssh://')) {
    throw new Error(
      `Unsupported scheme: ${uri.split('://')[0]}://. SSH auth requires operator keys ` +
        `and is out of scope for v1. Use git+https://github.com/owner/repo.git instead.`,
    );
  }

  // git+http:// — explicit reject (no plaintext clones).
  if (uri.startsWith('git+http://')) {
    throw new Error(
      `Unsupported scheme: git+http://. Plaintext git fetch is rejected; use git+https://.`,
    );
  }

  if (uri.startsWith('git+https://')) {
    return new GitFileSource(uri);
  }

  if (uri.startsWith('file://')) {
    return new LocalFileSource(uri);
  }

  if (uri.startsWith('https://')) {
    // Tarball schemes: must end in .tar.gz or .tgz (query-stripped).
    const pathPart = uri.split('?')[0]?.split('#')[0] ?? uri;
    if (pathPart.endsWith('.tar.gz') || pathPart.endsWith('.tgz')) {
      return new TarballFileSource(uri);
    }
    throw new Error(
      `Unsupported HTTPS URL: ${uri}. Only .tar.gz / .tgz are supported in v1 ` +
        `(no .zip, .7z, or raw directories).`,
    );
  }

  if (uri.startsWith('http://')) {
    throw new Error(
      `Unsupported scheme: http://. Plaintext tarball fetch is rejected; use https://.`,
    );
  }

  // Future schemes — surface them by name so the error tells operators what
  // we know about, not just "unknown".
  const knownFutureSchemes = ['s3://', 'gs://', 'azure://', 'gcs://', 'r2://'];
  for (const scheme of knownFutureSchemes) {
    if (uri.startsWith(scheme)) {
      throw new Error(
        `Scheme ${scheme} is reserved for a future implementation and not supported ` +
          `in v1 of FileSystemSource.`,
      );
    }
  }

  throw new Error(
    `Unsupported FileSystemSource URI: ${uri}. ` +
      `Expected git+https://…, https://…tar.gz, or file:///…`,
  );
}
