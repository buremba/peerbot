import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as git from 'isomorphic-git';
import { GitFileSource, parseGitUri } from '../sources/git-file-source.js';
import { DirectorySnapshot } from '../sources/snapshot.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.js';

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

  // Helper: seed the cache layout the way fetch() would, so diffSinceRef
  // sees a valid meta.json without doing a real network clone.
  async function seedCache(uri: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    const wd = join(cacheRoot, '.lobu-cache', 'sources', hash, 'snapshot');
    await mkdir(wd, { recursive: true });
    await writeFile(
      join(dirname(wd), 'meta.json'),
      JSON.stringify({ uri, kind: 'git' }, null, 2),
    );
    return wd;
  }

  test('diffs added/modified/removed across two commits', async () => {
    // Construct a source pointing at a syntactic URI; we won't call fetch().
    const uri = 'git+https://example.invalid/test/repo.git@main';
    const source = new GitFileSource(uri);

    workdir = await seedCache(uri);
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

  test('treats unknown prevRef as a full re-ingest (every current file → added)', async () => {
    const uri = 'git+https://example.invalid/test/repo2.git@main';
    const source = new GitFileSource(uri);
    workdir = await seedCache(uri);
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });

    await writeFile(join(workdir, 'a.json'), '{}');
    await writeFile(join(workdir, 'b.json'), '{}');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'b.json' });
    await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'm',
      author: { name: 'test', email: 't@example.com' },
    });

    // 40 zero hex chars is a syntactically-valid OID that the shallow clone
    // doesn't know about. Should round-trip as a full re-ingest, NOT throw.
    const delta = await source.diffSinceRef('0'.repeat(40));
    expect(delta.added.sort()).toEqual(['a.json', 'b.json']);
    expect(delta.modified).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  test('diffSinceRef without prior fetch() throws on missing meta', async () => {
    const uri = 'git+https://example.invalid/test/no-fetch.git@main';
    const source = new GitFileSource(uri);
    await expect(source.diffSinceRef('deadbeef')).rejects.toThrow(/not fetched|fetch\(\)/i);
  });

  test('diffSinceRef returns empty when prevRef === currentRef', async () => {
    const uri = 'git+https://example.invalid/test/repo3.git@main';
    const source = new GitFileSource(uri);
    workdir = await seedCache(uri);
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

describe('GitSnapshot immutability', () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'lobu-git-imm-'));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test('readFile returns bytes from the captured commit even after the working tree is rewritten', async () => {
    const { GitSnapshot } = await import('../sources/git-snapshot.js');
    const workdir = join(cacheRoot, 'repo');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });

    await writeFile(join(workdir, 'a.json'), 'v1');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    const sha1 = await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'v1',
      author: { name: 't', email: 't@e.com' },
    });

    const snap = new GitSnapshot(workdir, sha1, nodeFs);
    expect(await snap.readText('a.json')).toBe('v1');

    // Now rewrite the working tree: a different commit + a different on-disk
    // file. The snapshot should keep returning v1 because it reads the blob
    // for sha1, not the file on disk.
    await writeFile(join(workdir, 'a.json'), 'v2');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'v2',
      author: { name: 't', email: 't@e.com' },
    });

    // On-disk says v2; snapshot pinned to sha1 still says v1.
    expect(await snap.readText('a.json')).toBe('v1');
  });

  test('readFile rejects path-escape attempts', async () => {
    const { GitSnapshot } = await import('../sources/git-snapshot.js');
    const workdir = join(cacheRoot, 'repo2');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });
    await writeFile(join(workdir, 'a.json'), 'x');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    const sha = await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'init',
      author: { name: 't', email: 't@e.com' },
    });
    const snap = new GitSnapshot(workdir, sha, nodeFs);
    await expect(snap.readText('/etc/passwd')).rejects.toThrow(/absolute/i);
    await expect(snap.readText('../escape')).rejects.toThrow(/escapes/i);
  });
});

describe('GitFileSource hides .git from the connector', () => {
  let cacheRoot: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'lobu-git-hide-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = cacheRoot;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test('walkFiles + readFile do not expose .git internals', async () => {
    // Build a tiny clone-shaped fixture on disk, then construct the snapshot
    // directly so we exercise the exclude predicate without a real fetch().
    const uri = 'git+https://example.invalid/test/exclude.git@main';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    const workdir = join(cacheRoot, '.lobu-cache', 'sources', hash, 'snapshot');
    await mkdir(workdir, { recursive: true });
    await git.init({ fs: nodeFs, dir: workdir, defaultBranch: 'main' });
    await writeFile(join(workdir, 'a.json'), '{"x":1}');
    await git.add({ fs: nodeFs, dir: workdir, filepath: 'a.json' });
    await git.commit({
      fs: nodeFs,
      dir: workdir,
      message: 'init',
      author: { name: 't', email: 't@e.com' },
    });

    // The snapshot constructed by GitFileSource.fetch() uses
    // `exclude: isGitInternalPath`. Mirror that here:
    const snap = new DirectorySnapshot(workdir, 'whatever', {
      exclude: (rel) => rel === '.git' || rel.startsWith('.git/'),
    });

    const found: string[] = [];
    for await (const rel of snap.walkFiles('**')) found.push(rel);
    expect(found.some((p) => p === '.git' || p.startsWith('.git/'))).toBe(false);
    expect(found).toContain('a.json');

    await expect(snap.readText('.git/HEAD')).rejects.toThrow(/excluded/i);
  });
});

describe('GitFileSource redirect downgrade protection', () => {
  let cacheRoot: string;
  let originalWorkspaceDir: string | undefined;
  let originalTlsReject: string | undefined;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'lobu-git-dgrd-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = cacheRoot;
    originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // lgtm[js/disabling-certificate-validation]
    // Test-only: connects to an in-process HTTPS server with a self-signed
    // cert. Prod rejection is pinned by tls-verification.test.ts.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    if (originalTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
    await rm(cacheRoot, { recursive: true, force: true });
  });

  test('rejects fetch() when an https endpoint 302s to http', async () => {
    // Plaintext destination that would happily serve git protocol if the
    // source followed the downgrade — but we never expect a request here.
    let plaintextHit = false;
    const httpServer = createHttpServer((_req, res) => {
      plaintextHit = true;
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const httpAddr = httpServer.address() as AddressInfo;

    // HTTPS endpoint redirects the smart-http info/refs to plaintext.
    const httpsServer = createHttpsServer(
      { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
      (req, res) => {
        const target = `http://127.0.0.1:${httpAddr.port}${req.url}`;
        res.writeHead(302, { Location: target });
        res.end();
      },
    );
    await new Promise<void>((r) => httpsServer.listen(0, '127.0.0.1', r));
    const httpsAddr = httpsServer.address() as AddressInfo;

    try {
      const source = new GitFileSource(
        `git+https://127.0.0.1:${httpsAddr.port}/foo/bar.git@main`,
      );
      await expect(source.fetch()).rejects.toThrow(/plaintext|http:\/\/|non-https/i);
      expect(plaintextHit).toBe(false);
    } finally {
      await new Promise<void>((r) => httpsServer.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
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
