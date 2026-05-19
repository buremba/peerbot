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

  test('diffSinceRef without prior fetch() throws on missing meta', async () => {
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    await expect(source.diffSinceRef('0'.repeat(64))).rejects.toThrow(
      /not fetched|fetch\(\)/i,
    );
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

describe('LocalFileSource snapshot ref / bytes consistency under concurrent writes', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-race-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-race-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('snapshot.readFile bytes match the bytes that snapshot.ref was computed over, even with mid-fetch writes', async () => {
    // Bias the race: seed with a payload large enough that copy + hash take
    // long enough that a write fired off concurrently is likely to land
    // *somewhere* in the middle. We're not relying on the race firing —
    // the post-fix code makes this irrelevant: the staging copy is the
    // source of both the hash and the snapshot bytes, so they always
    // agree regardless of the source's state during the fetch.
    const big = 'x'.repeat(256 * 1024);
    const { writeFile: wf } = await import('node:fs/promises');
    for (let i = 0; i < 8; i++) await wf(join(fixtureDir, `f${i}.txt`), `${big}-v1-${i}`);

    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);

    // Kick off a concurrent rewrite of one file while fetch() is running.
    const racer = (async () => {
      // Tiny delay to land between the listing and the copy.
      await new Promise((r) => setTimeout(r, 1));
      for (let i = 0; i < 8; i++) await wf(join(fixtureDir, `f${i}.txt`), `${big}-v2-${i}`);
    })();

    const snap = await source.fetch();
    await racer;

    // Re-hash every file the snapshot exposes, build the canonical ref
    // externally, compare to `snap.ref`. If the implementation hashed live
    // bytes and copied different bytes, these would disagree.
    const { createHash } = await import('node:crypto');
    const seen: Array<{ path: string; sha256: string }> = [];
    for await (const rel of snap.walkFiles('**')) {
      const buf = await snap.readFile(rel);
      seen.push({ path: rel, sha256: createHash('sha256').update(buf).digest('hex') });
    }
    seen.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const h = createHash('sha256');
    for (const f of seen) {
      h.update(f.path);
      h.update('\0');
      h.update(f.sha256);
      h.update('\n');
    }
    expect(h.digest('hex')).toBe(snap.ref);
  });
});

describe('LocalFileSource per-ref cache pruning', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-prune-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-prune-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('keeps only the 3 most recent per-ref dirs across 4 fetches', async () => {
    const { writeFile: wf, readdir, stat: statFs } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);

    // 4 distinct contents → 4 distinct refs.
    for (let i = 0; i < 4; i++) {
      await wf(join(fixtureDir, 'a.txt'), `v${i}`);
      await source.fetch();
      // Bump mtime ordering for deterministic prune across fast clocks.
      await new Promise((r) => setTimeout(r, 5));
    }

    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    const refsDir = join(workspaceDir, '.lobu-cache', 'sources', hash, 'refs');
    const ents = await readdir(refsDir, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.staging.'));
    // Sanity: any staging dirs should have been moved/rm'd by now.
    expect(ents.filter((e) => e.isDirectory() && e.name.startsWith('.staging.'))).toEqual([]);
    expect(dirs).toHaveLength(3);
    // Don't pin which 3 — clock granularity can blur mtime ordering across
    // very fast successive writes — but assert the bound is held.
    // Per-ref manifest JSON files are kept indefinitely (used by diff).
    const jsons = ents.filter((e) => e.isFile() && e.name.endsWith('.json'));
    expect(jsons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('LocalFileSource snapshot immutability', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-imm-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-immws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('snapshot keeps reading old bytes after source files mutate', async () => {
    await writeFile(join(fixtureDir, 'a.json'), 'old');
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const snap = await source.fetch();
    expect(await snap.readText('a.json')).toBe('old');

    // Mutate the source root after the snapshot is taken.
    await writeFile(join(fixtureDir, 'a.json'), 'new');

    // The snapshot is pinned to the hardlinked per-ref dir. Even though the
    // source mutated, the snapshot's bytes are stable.
    expect(await snap.readText('a.json')).toBe('old');
  });

  test('older snapshots stay readable after a subsequent fetch()', async () => {
    await writeFile(join(fixtureDir, 'a.json'), 'v1');
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);
    const snap1 = await source.fetch();
    expect(await snap1.readText('a.json')).toBe('v1');

    // New content, new fetch() → new ref + new per-ref dir.
    await writeFile(join(fixtureDir, 'a.json'), 'v2');
    const snap2 = await source.fetch();
    expect(snap2.ref).not.toBe(snap1.ref);
    expect(await snap2.readText('a.json')).toBe('v2');

    // Old snapshot still reads v1 — its per-ref dir is untouched.
    expect(await snap1.readText('a.json')).toBe('v1');
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

describe('LocalFileSource hash-vs-bytes seal under staging-window attack (codex round 3 #1)', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-seal-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-seal-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('stream-seal-during-copy: source file mutated mid-fetch still yields a consistent (ref, bytes) pair (codex round 3 #1 repro)', async () => {
    // The actual immutability mechanism is the single-pass
    // stream-pipe: each file's sha256 is computed from the same bytes
    // that are written into the staging copy. When the SOURCE file is
    // rewritten while fetch() is running, the stream reader sees one
    // consistent snapshot of bytes (either old or new, possibly a
    // truncated tail), and BOTH the hash AND the staging copy record
    // exactly those bytes. Therefore snap.ref will always agree with
    // sha256(snap.readFile(path)) for every path — even though the
    // exact content is non-deterministic under the race.
    //
    // Pre-fix (round 2 code), the implementation copied first then
    // re-hashed staging in a second pass; an attacker who mutated
    // staging between the copy of file X and the hash of file X would
    // make ref disagree with the staging bytes. Stream-seal closes
    // that window by collapsing the two passes into one.
    const { writeFile: wf } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const pad = (i: number) => i.toString().padStart(2, '0');

    await writeFile(join(fixtureDir, 'a.txt'), 'ORIGINAL');
    // 12 large files so the copy pass takes long enough that the racer
    // can fire mid-stream — the very scenario stream-seal protects.
    const big = Buffer.alloc(8 * 1024 * 1024, 120);
    for (let i = 0; i < 12; i++) await wf(join(fixtureDir, `z${pad(i)}.bin`), big);

    // Concurrently rewrite source files while fetch() is running. The
    // racer simulates a hostile (or just busy) writer mutating the
    // source tree mid-copy.
    const racer = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      for (let i = 0; i < 12; i++)
        await wf(join(fixtureDir, `z${pad(i)}.bin`), Buffer.alloc(4 * 1024 * 1024, 121));
      await wf(join(fixtureDir, 'a.txt'), 'MUTATED_DURING_FETCH').catch(() => undefined);
    })();

    const snap = await new LocalFileSource(
      pathToFileURL(`${fixtureDir}/`).toString(),
    ).fetch();
    await racer;

    // Re-hash every file the snapshot exposes, rebuild the canonical
    // ref externally, compare to snap.ref. If the implementation
    // hashed live bytes and wrote different bytes to staging (the
    // pre-stream-seal failure mode), these would disagree.
    const seen: Array<{ path: string; sha256: string }> = [];
    for await (const rel of snap.walkFiles('**')) {
      const buf = await snap.readFile(rel);
      seen.push({ path: rel, sha256: createHash('sha256').update(buf).digest('hex') });
    }
    seen.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const h = createHash('sha256');
    for (const f of seen) {
      h.update(f.path);
      h.update('\0');
      h.update(f.sha256);
      h.update('\n');
    }
    expect(h.digest('hex')).toBe(snap.ref);
  }, 60_000);
});

describe('LocalFileSource cache-hit prune protection (codex round 3 #4)', () => {
  let fixtureDir: string;
  let workspaceDir: string;
  let originalWorkspaceDir: string | undefined;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-hitprune-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-localfs-hitprune-ws-'));
    originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceDir;
  });

  afterEach(async () => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('cache-hit on the oldest ref protects it from being pruned out from under the Snapshot', async () => {
    const { writeFile: wf, utimes } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const uri = pathToFileURL(`${fixtureDir}/`).toString();
    const source = new LocalFileSource(uri);

    // 1) Fetch ref v0 — this is the dir we'll later re-hit. Force its mtime
    //    to the deep past so any mtime-sort sees it as the oldest.
    await wf(join(fixtureDir, 'a.txt'), 'v0');
    const snapV0 = await source.fetch();

    const hash = createHash('sha256').update(uri).digest('hex').slice(0, 32);
    const refsDir = join(workspaceDir, '.lobu-cache', 'sources', hash, 'refs');
    const v0Dir = join(refsDir, snapV0.ref);

    const ancient = new Date(2000, 0, 1);
    await utimes(v0Dir, ancient, ancient).catch(() => undefined);

    // 2) Produce three NEWER refs so we cross MAX_REF_DIRS=3 on the next
    //    cache-hit fetch. Each gets a normal "now" mtime.
    for (let i = 1; i <= 3; i++) {
      await wf(join(fixtureDir, 'a.txt'), `v${i}`);
      await source.fetch();
      await new Promise((r) => setTimeout(r, 5));
    }

    // 3) Restore source content to v0 and fetch again. This is the
    //    cache-hit branch: `refs/<v0>` already exists, fetch() skips the
    //    install and reuses the existing dir. Pre-fix, the prune step
    //    sorted by mtime, saw v0 as oldest, and rm'd it — leaving the
    //    just-returned Snapshot pointing at an ENOENT dir. Post-fix,
    //    `protectedRefDir` keeps v0 even though its mtime is ancient.
    await wf(join(fixtureDir, 'a.txt'), 'v0');
    const snapHit = await source.fetch();
    expect(snapHit.ref).toBe(snapV0.ref);

    // The Snapshot must still be readable — its backing dir survived prune.
    expect(await snapHit.readText('a.txt')).toBe('v0');
  });
});
