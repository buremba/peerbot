import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalFileSource } from '../sources/local-file-source.js';

describe('LocalFileSource', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-fix-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;

    await writeFile(join(fixtureDir, 'a.json'), '{"x":1}');
    await writeFile(join(fixtureDir, 'b.json'), '{"x":2}');
    await mkdir(join(fixtureDir, 'sub'));
    await writeFile(join(fixtureDir, 'sub', 'c.json'), '{"x":3}');
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('fetch() returns a snapshot with a stable ref and walks files', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const snap = await source.fetch();

    expect(snap.ref).toMatch(/^[a-f0-9]{64}$/);

    const found: string[] = [];
    for await (const rel of snap.walkFiles('**')) found.push(rel);
    expect(found.sort()).toEqual(['a.json', 'b.json', 'sub/c.json']);

    const a = await snap.readText('a.json');
    expect(a).toBe('{"x":1}');
    const aBuf = await snap.readFile('a.json');
    expect(aBuf).toBeInstanceOf(Buffer);
    expect(aBuf.toString('utf8')).toBe('{"x":1}');
  });

  test('readFile refuses paths that escape the snapshot root', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const snap = await source.fetch();
    await expect(snap.readText('../etc/passwd')).rejects.toThrow(/escapes/i);
    await expect(snap.readText('/etc/passwd')).rejects.toThrow(/absolute/i);
  });

  test('ref is stable when content does not change', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const a = await source.fetch();
    const b = await source.fetch();
    expect(a.ref).toBe(b.ref);
  });

  test('diffSinceRef detects added / modified / removed', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const initial = await source.fetch();

    // Mutate: add d.json, modify a.json, remove b.json
    await writeFile(join(fixtureDir, 'd.json'), '{"x":4}');
    await writeFile(join(fixtureDir, 'a.json'), '{"x":99}');
    await rm(join(fixtureDir, 'b.json'));

    const delta = await source.diffSinceRef(initial.ref);
    expect(delta.added.sort()).toEqual(['d.json']);
    expect(delta.modified.sort()).toEqual(['a.json']);
    expect(delta.removed.sort()).toEqual(['b.json']);
  });

  test('diffSinceRef returns empty when content unchanged', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const snap = await source.fetch();
    const delta = await source.diffSinceRef(snap.ref);
    expect(delta).toEqual({ added: [], modified: [], removed: [] });
  });

  test('diffSinceRef against unknown prevRef treats everything as added', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    await source.fetch();
    const delta = await source.diffSinceRef('0'.repeat(64));
    expect(delta.added.sort()).toEqual(['a.json', 'b.json', 'sub/c.json']);
    expect(delta.modified).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  test('throws when target directory does not exist', async () => {
    const uri = pathToFileURL(`${fixtureDir}-nope/`).toString();
    const source = new LocalFileSource(uri);
    await expect(source.fetch()).rejects.toThrow(/not a directory/i);
  });
});

describe('LocalFileSource .lobu-cache exclusion', () => {
  let outerSource: string;
  let nestedWorkspace: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    outerSource = await mkdtemp(join(tmpdir(), 'lobu-localfs-nest-src-'));
    // WORKSPACE_DIR lives INSIDE the source root → cache will be at
    // `${outerSource}/inner/.lobu-cache`. The exclude predicate must scope
    // to that exact subtree.
    nestedWorkspace = join(outerSource, 'inner');
    await mkdir(nestedWorkspace);
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = nestedWorkspace;

    await writeFile(join(outerSource, 'top.md'), 'top');
    await writeFile(join(nestedWorkspace, 'kept.md'), 'kept'); // inside `inner/`, NOT cache
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(outerSource, { recursive: true, force: true });
  });

  test('excludes nested .lobu-cache when WORKSPACE_DIR is inside the source', async () => {
    const uri = pathToFileURL(`${outerSource}/`).toString();
    const source = new LocalFileSource(uri);
    const snap1 = await source.fetch();

    // Cache files are now under `inner/.lobu-cache/` — those must be excluded.
    const found1: string[] = [];
    for await (const rel of snap1.walkFiles('**')) found1.push(rel);
    expect(found1.some((p) => p.includes('.lobu-cache'))).toBe(false);
    expect(found1.sort()).toContain('top.md');
    expect(found1.sort()).toContain('inner/kept.md');

    // A second fetch must yield the SAME ref — proves cache writes aren't being
    // ingested (which would change the manifest each call).
    const snap2 = await source.fetch();
    expect(snap2.ref).toBe(snap1.ref);
  });

  test('does NOT over-exclude a real top-level .lobu-cache when cache is elsewhere', async () => {
    // Use a workspace dir OUTSIDE the source — the source's literal
    // `.lobu-cache` directory is real data, not our cache.
    const externalWorkspace = await mkdtemp(join(tmpdir(), 'lobu-localfs-ext-ws-'));
    const savedWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = externalWorkspace;
    try {
      await mkdir(join(outerSource, '.lobu-cache'));
      await writeFile(join(outerSource, '.lobu-cache', 'real-data.txt'), 'user data');

      const uri = pathToFileURL(`${outerSource}/`).toString();
      const source = new LocalFileSource(uri);
      const snap = await source.fetch();
      const found: string[] = [];
      for await (const rel of snap.walkFiles('**')) found.push(rel);
      expect(found).toContain('.lobu-cache/real-data.txt');
    } finally {
      if (savedWorkspace !== undefined) process.env.WORKSPACE_DIR = savedWorkspace;
      else delete process.env.WORKSPACE_DIR;
      await rm(externalWorkspace, { recursive: true, force: true });
    }
  });
});
