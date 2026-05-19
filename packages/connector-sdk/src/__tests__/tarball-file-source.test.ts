import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { c as tarCreate } from 'tar';
import { TarballFileSource } from '../sources/tarball-file-source.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.js';

/**
 * Tarball tests use a localhost HTTPS server with a self-signed cert (no
 * external network). `NODE_TLS_REJECT_UNAUTHORIZED=0` is scoped to this
 * test file. The resolver-level https-only check is exercised in
 * file-source-resolver.test.ts.
 */
describe('TarballFileSource', () => {
  let server: Server;
  let baseUrl: string;
  let fixtureDir: string;
  let tarballPath: string;
  let alternateTarballPath: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeAll(async () => {
    // Build two tarballs once: initial and modified.
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-tarball-fix-'));
    const v1 = join(fixtureDir, 'v1');
    await mkdir(v1, { recursive: true });
    await writeFile(join(v1, 'a.json'), '{"x":1}');
    await writeFile(join(v1, 'b.json'), '{"x":2}');
    tarballPath = join(fixtureDir, 'v1.tar.gz');
    await tarCreate({ gzip: true, file: tarballPath, cwd: v1 }, ['.']);

    const v2 = join(fixtureDir, 'v2');
    await mkdir(v2, { recursive: true });
    await writeFile(join(v2, 'a.json'), '{"x":99}'); // modified
    await writeFile(join(v2, 'c.json'), '{"x":3}'); // added; b.json removed
    alternateTarballPath = join(fixtureDir, 'v2.tar.gz');
    await tarCreate({ gzip: true, file: alternateTarballPath, cwd: v2 }, ['.']);

    // Mutable pointer so the server can swap which tarball it serves.
    serveTarballPath = tarballPath;

    server = createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (req, res) => {
      if (req.url === '/missing.tar.gz') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url?.endsWith('.tar.gz') || req.url?.endsWith('.tgz')) {
        readFile(serveTarballPath).then(
          (buf) => {
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            res.end(buf);
          },
          () => {
            res.writeHead(500);
            res.end();
          },
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${addr.port}`;
    originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // lgtm[js/disabling-certificate-validation]
    // Test-only: connects to an in-process HTTPS server with a self-signed
    // cert. Prod rejection is pinned by tls-verification.test.ts.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtureDir, { recursive: true, force: true });
    if (originalTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
  });

  let serveTarballPath: string;
  let originalTlsReject: string | undefined;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-tarball-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
    serveTarballPath = tarballPath;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('fetch() downloads, extracts, and exposes files via the Snapshot', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const snap = await source.fetch();
    expect(snap.ref).toMatch(/^[a-f0-9]{64}$/);

    const found: string[] = [];
    for await (const rel of snap.walkFiles('**')) found.push(rel);
    expect(found.sort()).toEqual(['a.json', 'b.json']);
    expect(await snap.readText('a.json')).toBe('{"x":1}');
  });

  test('cache hit: re-fetch with same content yields same ref', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const a = await source.fetch();
    const b = await source.fetch();
    expect(b.ref).toBe(a.ref);
  });

  test('diffSinceRef detects added / modified / removed across versions', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const initial = await source.fetch();

    // Server now serves v2.
    serveTarballPath = alternateTarballPath;

    const delta = await source.diffSinceRef(initial.ref);
    expect(delta.added.sort()).toEqual(['c.json']);
    expect(delta.modified.sort()).toEqual(['a.json']);
    expect(delta.removed.sort()).toEqual(['b.json']);
  });

  test('diffSinceRef returns empty when nothing changed', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const snap = await source.fetch();
    const delta = await source.diffSinceRef(snap.ref);
    expect(delta).toEqual({ added: [], modified: [], removed: [] });
  });

  test('rejects non-tarball URI at construction', () => {
    expect(() => new TarballFileSource('https://example.com/x.zip')).toThrow(
      /\.tar\.gz/i,
    );
  });

  test('surfaces non-2xx HTTP responses', async () => {
    const source = new TarballFileSource(`${baseUrl}/missing.tar.gz`);
    await expect(source.fetch()).rejects.toThrow(/404/);
  });

  test('install is atomic: a failed second fetch() leaves the existing snapshot intact', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const v1 = await source.fetch();
    expect(await v1.readText('a.json')).toBe('{"x":1}');

    // Next fetch will 404 (server returns 404 for `/missing.tar.gz`). To
    // exercise the same fetch path against a failing response, build a
    // second source pointing at the missing URL — but we want fetch() to
    // fail on the SAME source. The TarballFileSource caches by URI, so we
    // simulate failure by pointing the server at a non-existent file.
    serveTarballPath = '/this/path/does/not/exist';
    await expect(source.fetch()).rejects.toThrow();

    // Old snapshot's per-ref dir is untouched — bytes still readable.
    expect(await v1.readText('a.json')).toBe('{"x":1}');
  });

  test('prunes old per-ref dirs to at most 3 across 4 distinct refs', async () => {
    // Build 4 distinct tarballs, swap them in turn, and assert the
    // refs/ directory holds at most 3 ref dirs after the 4th fetch.
    const extras: string[] = [];
    for (let i = 0; i < 4; i++) {
      const dir = join(fixtureDir, `vp${i}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a.json'), `{"v":${i}}`);
      const p = join(fixtureDir, `vp${i}.tar.gz`);
      await tarCreate({ gzip: true, file: p, cwd: dir }, ['.']);
      extras.push(p);
    }
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    for (let i = 0; i < extras.length; i++) {
      serveTarballPath = extras[i] as string;
      await source.fetch();
      // Bump mtime granularity for prune ordering.
      await new Promise((r) => setTimeout(r, 5));
    }
    const { createHash } = await import('node:crypto');
    const { readdir: readdirP } = await import('node:fs/promises');
    const hash = createHash('sha256')
      .update(`${baseUrl}/dataset.tar.gz`)
      .digest('hex')
      .slice(0, 32);
    const refsDir = join(workspaceDir, '.lobu-cache', 'sources', hash, 'refs');
    const ents = await readdirP(refsDir, { withFileTypes: true });
    const dirs = ents.filter(
      (e) => e.isDirectory() && !e.name.startsWith('snapshot.tmp.'),
    );
    expect(dirs.length).toBeLessThanOrEqual(3);
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    // Per-ref manifest JSON files remain so historical diffs work.
    expect(ents.filter((e) => e.isFile() && e.name.endsWith('.json')).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  test('diffSinceRef on a fresh cache throws before issuing a network fetch', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    await expect(source.diffSinceRef('cafe'.repeat(16))).rejects.toThrow(
      /not fetched|fetch\(\)/i,
    );
  });

  test('rejects an https→http redirect (no plaintext downgrade)', async () => {
    // Stand up a tiny HTTP server that would happily serve the tarball if
    // the source followed the downgrade. The HTTPS server 302s to it.
    const httpServer = createHttpServer((_req, res) => {
      readFile(tarballPath).then((buf) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(buf);
      });
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const httpAddr = httpServer.address() as AddressInfo;
    const downgradeTarget = `http://127.0.0.1:${httpAddr.port}/leak.tar.gz`;

    // Replace the existing request handler with one that 302s the downgrade
    // URL; restore the original after the test.
    const originalListeners = server.listeners('request') as Array<
      (...args: unknown[]) => void
    >;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/downgrade.tar.gz') {
        res.writeHead(302, { Location: downgradeTarget });
        res.end();
        return;
      }
      // Fall back to the original handler for unrelated paths.
      for (const l of originalListeners) (l as (...args: unknown[]) => void)(req, res);
    });
    try {
      const source = new TarballFileSource(`${baseUrl}/downgrade.tar.gz`);
      await expect(source.fetch()).rejects.toThrow(/plaintext|http:\/\//i);
    } finally {
      server.removeAllListeners('request');
      for (const l of originalListeners) server.on('request', l);
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });

  test('older snapshot stays readable after a subsequent fetch() of new content', async () => {
    const source = new TarballFileSource(`${baseUrl}/dataset.tar.gz`);
    const v1 = await source.fetch();
    expect(await v1.readText('a.json')).toBe('{"x":1}');

    // Swap the server's response and re-fetch — the source extracts into a
    // fresh per-ref dir, leaving the v1 dir untouched.
    serveTarballPath = alternateTarballPath;
    const v2 = await source.fetch();
    expect(v2.ref).not.toBe(v1.ref);
    expect(await v2.readText('a.json')).toBe('{"x":99}');

    // v1 still reads its pinned content — proves the old per-ref dir wasn't
    // overwritten and any caller holding v1 still gets the original bytes.
    expect(await v1.readText('a.json')).toBe('{"x":1}');
  });
});
