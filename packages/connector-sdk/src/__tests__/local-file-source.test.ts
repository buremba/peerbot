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
