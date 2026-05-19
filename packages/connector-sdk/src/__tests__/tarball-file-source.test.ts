import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { c as tarCreate } from 'tar';
import { TarballFileSource } from '../sources/tarball-file-source.js';

/**
 * Tarball tests use a localhost http server (no external network) and
 * bypass the resolver so we can use `http://`. The TarballFileSource
 * constructor accepts http(s) — the resolver-level https-only check is
 * exercised in file-source-resolver.test.ts.
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

    server = createServer((req, res) => {
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
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtureDir, { recursive: true, force: true });
  });

  let serveTarballPath: string;

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
});
