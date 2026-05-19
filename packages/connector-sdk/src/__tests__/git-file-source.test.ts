import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { GitFileSource, parseGitUri } from '../sources/git-file-source.js';
import { DirectorySnapshot } from '../sources/snapshot.js';

describe('parseGitUri', () => {
  test('parses URL with @ref', () => {
    expect(parseGitUri('git+https://github.com/foo/bar.git@feature')).toEqual({
      url: 'https://github.com/foo/bar.git',
      ref: 'feature',
    });
  });

  test('parses URL without @ref → defaults to main', () => {
    expect(parseGitUri('git+https://github.com/foo/bar.git')).toEqual({
      url: 'https://github.com/foo/bar.git',
      ref: 'main',
    });
  });

  test('parses URL with full SHA as ref', () => {
    expect(parseGitUri('git+https://github.com/foo/bar.git@deadbeef').ref).toBe('deadbeef');
  });

  test('does not split on @ in userinfo (https://user@host/x.git)', () => {
    // userinfo `@` comes BEFORE the first `/` after `://`, so the parser
    // ignores it and treats the URL as ref-less.
    expect(parseGitUri('git+https://user@github.com/foo/bar.git')).toEqual({
      url: 'https://user@github.com/foo/bar.git',
      ref: 'main',
    });
  });

  test('rejects non-git+http(s) URIs', () => {
    expect(() => parseGitUri('https://github.com/foo/bar.git')).toThrow(/git\+http/);
  });
});

/**
 * Builds a small local git repo via isomorphic-git, then drives
 * GitFileSource against it via a `file://` URL (yes — isomorphic-git's smart
 * HTTP client can NOT talk to a local repo, so these tests exercise the diff
 * surface directly against a built-by-hand cache).
 *
 * We bypass `fetch()` (no network) and seed the cache directory ourselves,
 * then call `diffSinceRef()` against the resulting repo.
 */
describe('GitFileSource diffSinceRef', () => {
  let cacheRoot: string;
  let originalWorkspaceDir: string | undefined;
  let workdir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'lobu-git-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = cacheRoot;
    workdir = '';
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test('diffs added/modified/removed across two commits', async () => {
    // Construct a source pointing at a syntactic URI; we won't call fetch().
    const uri = 'git+https://example.invalid/test/repo.git@main';
    const source = new GitFileSource(uri);

    // Find the cache dir the source would use, and build a real repo there.
    // (Cache hash is sha256(uri)[:32].)
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    workdir = join(cacheRoot, '.lobu-cache', 'sources', hash, 'snapshot');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });

    const commit = async (msg: string) =>
      git.commit({
        fs: nodeFs,
        dir: workdir,
        message: msg,
        author: { name: 'test', email: 't@example.com' },
      });

    await writeFile(join(workdir, 'a.json'), '{"x":1}');
    await writeFile(join(workdir, 'b.json'), '{"x":2}');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'b.json' });
    const sha1 = await commit('initial');

    await writeFile(join(workdir, 'a.json'), '{"x":99}'); // modified
    await rm(join(workdir, 'b.json')); // removed
    await writeFile(join(workdir, 'c.json'), '{"x":3}'); // added
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.remove({ fs: nodeFs, dir: workdir, filepath: 'b.json' });
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'c.json' });
    const sha2 = await commit('second');
    expect(sha1).not.toBe(sha2);

    const delta = await source.diffSinceRef(sha1);
    expect(delta.added.sort()).toEqual(['c.json']);
    expect(delta.modified.sort()).toEqual(['a.json']);
    expect(delta.removed.sort()).toEqual(['b.json']);
  });

  test('throws clearly when prevRef is unknown to the local clone', async () => {
    const uri = 'git+https://example.invalid/test/repo2.git@main';
    const source = new GitFileSource(uri);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    workdir = join(cacheRoot, '.lobu-cache', 'sources', hash, 'snapshot');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });

    await writeFile(join(workdir, 'a.json'), '{}');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'm',
      author: { name: 'test', email: 't@example.com' },
    });

    await expect(source.diffSinceRef('0'.repeat(40))).rejects.toThrow(/not present/i);
  });

  test('diffSinceRef returns empty when prevRef === currentRef', async () => {
    const uri = 'git+https://example.invalid/test/repo3.git@main';
    const source = new GitFileSource(uri);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    workdir = join(cacheRoot, '.lobu-cache', 'sources', hash, 'snapshot');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });
    await writeFile(join(workdir, 'a.json'), '{}');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    const sha = await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'm',
      author: { name: 'test', email: 't@example.com' },
    });

    const delta = await source.diffSinceRef(sha);
    expect(delta).toEqual({ added: [], modified: [], removed: [] });
  });
});

describe('DirectorySnapshot security', () => {
  test('relative readFile inside snapshot works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lobu-snap-'));
    try {
      await writeFile(join(dir, 'ok.txt'), 'hello');
      const snap = new DirectorySnapshot(dir, 'abc');
      expect(await snap.readText('ok.txt')).toBe('hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses paths that escape via ..', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lobu-snap-'));
    try {
      const snap = new DirectorySnapshot(dir, 'abc');
      await expect(snap.readFile('../escape')).rejects.toThrow(/escapes/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
