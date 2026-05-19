/**
 * Concrete `Snapshot` backed by a directory on disk. Reused by all three
 * source implementations — the rootDir stays hidden from the connector.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Snapshot } from '../file-source.js';
import { matchesGlob, walkDirectoryRelative } from './glob.js';

export class DirectorySnapshot implements Snapshot {
  readonly ref: string;
  /** @internal — NOT exported on the public Snapshot interface. */
  readonly #rootDir: string;

  constructor(rootDir: string, ref: string) {
    this.#rootDir = resolve(rootDir);
    this.ref = ref;
  }

  async *walkFiles(glob: string): AsyncIterable<string> {
    for await (const rel of walkDirectoryRelative(this.#rootDir)) {
      if (matchesGlob(rel, glob)) yield rel;
    }
  }

  async readFile(relativePath: string): Promise<Buffer> {
    return readFile(this.#resolveSafe(relativePath));
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.#resolveSafe(relativePath), 'utf8');
  }

  /**
   * Resolve `relativePath` inside `rootDir`, refusing any path that escapes
   * the snapshot root via `..` or absolute-path injection.
   */
  #resolveSafe(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`Snapshot.readFile: absolute paths are not allowed (${relativePath})`);
    }
    const joined = normalize(join(this.#rootDir, relativePath));
    const rel = relative(this.#rootDir, joined);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new Error(`Snapshot.readFile: path escapes snapshot root (${relativePath})`);
    }
    return joined;
  }
}
