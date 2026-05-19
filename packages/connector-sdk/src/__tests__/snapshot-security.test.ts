import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalFileSource } from '../sources/local-file-source.js';
import { DirectorySnapshot } from '../sources/snapshot.js';

describe('Snapshot security: symlink escape', () => {
  let dir: string;
  let outsideDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lobu-snap-sec-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'lobu-snap-out-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'top secret');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test('refuses to follow a symlink that points outside the snapshot root', async () => {
    await symlink(join(outsideDir, 'secret.txt'), join(dir, 'evil'));
    const snap = new DirectorySnapshot(dir, 'abc');
    await expect(snap.readText('evil')).rejects.toThrow(/symlink/i);
  });

  test('allows a symlink that points to a file under the snapshot root', async () => {
    await writeFile(join(dir, 'real.txt'), 'ok');
    await symlink(join(dir, 'real.txt'), join(dir, 'mirror'));
    const snap = new DirectorySnapshot(dir, 'abc');
    expect(await snap.readText('mirror')).toBe('ok');
  });
});

describe('LocalFileSource: self-ingestion of .lobu-cache', () => {
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-selfingest-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('ref is stable when source root === workspace root (no .lobu-cache pollution)', async () => {
    // Source root IS the workspace root: the SDK cache will be written
    // inside it. The fix is to skip `.lobu-cache/` in walks + manifests.
    await writeFile(join(workspaceDir, 'a.json'), '{"x":1}');
    const uri = pathToFileURL(`${workspaceDir}/`).toString();
    const source = new LocalFileSource(uri);

    const a = await source.fetch();
    const b = await source.fetch();
    expect(b.ref).toBe(a.ref);

    // walkFiles should NOT yield anything under `.lobu-cache/`.
    const seen: string[] = [];
    for await (const rel of a.walkFiles('**')) seen.push(rel);
    expect(seen).toEqual(['a.json']);
    expect(seen.some((p) => p.startsWith('.lobu-cache'))).toBe(false);

    // readText on a `.lobu-cache/` path fails — the snapshot is materialised
    // into a per-ref pinned dir and `.lobu-cache/` was filtered out at install
    // time. It doesn't exist inside the snapshot's view.
    await expect(a.readText('.lobu-cache/sources/foo')).rejects.toThrow();
  });
});
