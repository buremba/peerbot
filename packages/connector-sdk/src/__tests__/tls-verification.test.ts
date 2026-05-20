/**
 * Pins that the SDK's HTTPS-using sources reject a self-signed cert when
 * TLS verification is on.
 *
 * We run the actual fetch in a fresh `bun` subprocess. Two reasons:
 *
 *   1. Bun's test runner shares one process across all test files, and
 *      `NODE_TLS_REJECT_UNAUTHORIZED='0'` set by any prior file leaks here.
 *   2. Even within one process, once TLS verification has been disabled
 *      via that env var, restoring it does NOT re-enable strict
 *      verification — Node/Bun appears to latch the relaxed state. A
 *      subprocess starts with a guaranteed-clean TLS module.
 *
 * If a future change globally disables cert verification (e.g. someone
 * sets `NODE_TLS_REJECT_UNAUTHORIZED='0'` from a setup file in the
 * subprocess script), these tests start failing — exactly the regression
 * we want to catch.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.js';

// Resolve the on-disk locations of the source impls so the subprocess can
// import them via absolute paths — avoids "@lobu/connector-sdk" resolution
// surprises in the spawned process.
const tarballSourcePath = join(
  import.meta.dir,
  '..',
  'sources',
  'tarball-file-source.ts',
);
const gitSourcePath = join(import.meta.dir, '..', 'sources', 'git-file-source.ts');

async function runInClean(script: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  // Carry over PATH and HOME (needed for bun's resolution + tmpdir defaults)
  // but explicitly strip NODE_TLS_REJECT_UNAUTHORIZED so the subprocess
  // boots with strict TLS verification.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_TLS_REJECT_UNAUTHORIZED') continue;
    if (v !== undefined) env[k] = v;
  }
  const child = spawn('bun', ['-e', script], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('TLS verification on by default', () => {
  let server: Server;
  let baseUrl: string;
  let fixtureDir: string;
  let tarballPath: string;
  let workspaceDir: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'lobu-tls-fix-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lobu-tls-ws-'));

    const v1 = join(fixtureDir, 'v1');
    await mkdir(v1, { recursive: true });
    await writeFile(join(v1, 'a.json'), '{"x":1}');
    tarballPath = join(fixtureDir, 'v1.tar.gz');
    await tarCreate({ gzip: true, file: tarballPath, cwd: v1 }, ['.']);

    server = createHttpsServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (_req, res) => {
      readFile(tarballPath).then((buf) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(buf);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test('TarballFileSource rejects a self-signed cert', async () => {
    const script = `
      process.env.WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};
      const { TarballFileSource } = await import(${JSON.stringify(tarballSourcePath)});
      const src = new TarballFileSource(${JSON.stringify(`${baseUrl}/dataset.tar.gz`)});
      try {
        await src.fetch();
        console.log('FETCHED_OK');
      } catch (e) {
        console.log('ERR:', e && e.message ? e.message : String(e));
      }
    `;
    const { stdout } = await runInClean(script);
    expect(stdout).not.toContain('FETCHED_OK');
    expect(stdout).toMatch(
      /self[- ]signed|unable to verify|certificate|UNABLE_TO_VERIFY|SELF_SIGNED|fetch failed/i,
    );
  });

  test('GitFileSource rejects a self-signed cert', async () => {
    const script = `
      process.env.WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};
      const { GitFileSource } = await import(${JSON.stringify(gitSourcePath)});
      const src = new GitFileSource(${JSON.stringify(`git+${baseUrl}/foo/bar.git@main`)});
      try {
        await src.fetch();
        console.log('FETCHED_OK');
      } catch (e) {
        console.log('ERR:', e && e.message ? e.message : String(e));
      }
    `;
    const { stdout } = await runInClean(script);
    expect(stdout).not.toContain('FETCHED_OK');
    expect(stdout).toMatch(
      /self[- ]signed|unable to verify|certificate|UNABLE_TO_VERIFY|SELF_SIGNED/i,
    );
  });
});
