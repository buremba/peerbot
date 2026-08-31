#!/usr/bin/env bash
# Prove the published connector-worker tarball contains a working daemon-owned
# os.shell backend, then boot that exact artifact twice against the worker HTTP
# contract. The direct import deliberately runs before dependencies are made
# available, so it fails if the built-in grows a runtime dependency on
# @lobu/connector-sdk or the dynamic compiler. The daemon phase covers poll,
# manifest advertisement, execution, completion, shutdown, and restart.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$repo_root/packages/connector-worker"
test -f "$package_root/dist/daemon/builtins/index.js" || {
  echo "connector-worker dist is missing; build packages before this smoke" >&2
  exit 1
}

smoke_dir="$(mktemp -d)"
daemon_cwd="$(mktemp -d)"
raw_runtime="$smoke_dir/raw-runtime"
mkdir -p "$raw_runtime"
trap 'rm -rf "$smoke_dir" "$daemon_cwd"' EXIT

(cd "$package_root" && bun pm pack --destination "$smoke_dir" --quiet) >/dev/null
archives=("$smoke_dir"/*.tgz)
test "${#archives[@]}" -eq 1 || {
  echo "expected one connector-worker tarball, found ${#archives[@]}" >&2
  exit 1
}
tar -xzf "${archives[0]}" -C "$raw_runtime"

PACKAGE_ROOT="$raw_runtime/package" node --input-type=module <<'NODE'
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = resolve(process.env.PACKAGE_ROOT, 'dist/daemon/builtins/index.js');
const { executeDaemonBuiltin } = await import(pathToFileURL(entry).href);
const result = await executeDaemonBuiltin({
  connectorKey: 'os.shell',
  actionKey: 'run',
  input: { command: "printf 'lobu-shell-ok\\n'", cwd: process.cwd() },
});
if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
const output = result.output;
if (
  output.stdout !== 'lobu-shell-ok\n' ||
  output.stderr !== '' ||
  output.exit_code !== 0 ||
  output.success !== true ||
  output.timed_out !== false
) {
  throw new Error(`unexpected shell result: ${JSON.stringify(output)}`);
}
process.stdout.write('packaged os.shell dependency-isolation check: ok\n');
NODE

# Exercise the customer path too: apply the repository's publish transform to
# isolated copies, pack the public CLI and its worker dependency, install into
# an empty npm prefix, and invoke the installed `lobu daemon` bin. No workspace
# node_modules link is present in this phase.
published_dir="$smoke_dir/published"
mkdir -p "$published_dir/core" "$published_dir/connector-sdk" "$published_dir/embeddings" \
  "$published_dir/connector-worker" "$published_dir/worker" "$published_dir/cli" "$smoke_dir/prefix"
cp -R "$repo_root/packages/core/." "$published_dir/core/"
cp -R "$repo_root/packages/connector-sdk/." "$published_dir/connector-sdk/"
cp -R "$repo_root/packages/embeddings/." "$published_dir/embeddings/"
cp -R "$package_root/." "$published_dir/connector-worker/"
cp -R "$repo_root/packages/agent-worker/." "$published_dir/worker/"
cp -R "$repo_root/packages/cli/." "$published_dir/cli/"
PUBLISH_REPO_ROOT="$repo_root" PUBLISH_PACKAGE_ROOTS="$published_dir/core:$published_dir/connector-sdk:$published_dir/embeddings:$published_dir/connector-worker:$published_dir/worker:$published_dir/cli" node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { __testing, rewriteWorkspaceRefs } from './scripts/publish-packages.mjs';

for (const root of process.env.PUBLISH_PACKAGE_ROOTS.split(':')) {
  const path = `${root}/package.json`;
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  const transform = root.endsWith('/core')
    ? __testing.transformCorePublish
    : root.endsWith('/worker')
      ? __testing.transformWorkerPublish
      : rewriteWorkspaceRefs;
  await writeFile(path, `${JSON.stringify(transform(pkg), null, 2)}\n`);
}
NODE
(cd "$published_dir/core" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
(cd "$published_dir/connector-sdk" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
(cd "$published_dir/embeddings" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
(cd "$published_dir/connector-worker" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
(cd "$published_dir/worker" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
(cd "$published_dir/cli" && bun pm pack --destination "$published_dir" --quiet) >/dev/null
published_archives=("$published_dir"/*.tgz)
test "${#published_archives[@]}" -eq 6 || {
  echo "expected six transformed local @lobu tarballs" >&2
  exit 1
}
npm install --prefix "$smoke_dir/prefix" --no-audit --no-fund \
  "${published_archives[@]}" >/dev/null
test ! -L "$smoke_dir/prefix/node_modules" || {
  echo "published install unexpectedly uses a node_modules symlink" >&2
  exit 1
}
PUBLISHED_PREFIX="$smoke_dir/prefix" node --input-type=module <<'NODE'
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const prefix = process.env.PUBLISHED_PREFIX;
const bin = resolve(prefix, 'node_modules/.bin/lobu');
await access(bin);
const workerBuiltins = resolve(prefix, 'node_modules/@lobu/connector-worker/dist/daemon/builtins/index.js');
await access(workerBuiltins);
const cliRequire = createRequire(bin);
const workerRequire = createRequire(workerBuiltins);
for (const [label, require_] of [['installed CLI', cliRequire], ['installed worker', workerRequire]]) {
  try {
    require_.resolve('@lobu/connector-sdk');
  } catch (error) {
    throw new Error(`${label} cannot resolve local @lobu/connector-sdk: ${error.message}`);
  }
  try {
    require_.resolve('@lobu/connector-worker/compile');
    throw new Error(`${label} resolved compiler-only @lobu/connector-worker/compile`);
  } catch (error) {
    if (error.message.includes('resolved compiler-only')) throw error;
  }
}
const builtinsSource = await readFile(workerBuiltins, 'utf8');
for (const forbidden of ['/compile/index']) {
  if (builtinsSource.includes(forbidden)) {
    throw new Error(`published daemon built-ins retain compiler/SDK dependency: ${forbidden}`);
  }
}
process.stdout.write('published install dependency boundary: ok\n');
NODE

# The raw daemon gets the repository dependency graph only in its own isolated
# sibling. The published CLI's ancestor chain never contains this link.
ln -s "$repo_root/node_modules" "$raw_runtime/node_modules"

PACKAGE_ROOT="$raw_runtime/package" PUBLISHED_ENTRY="$smoke_dir/prefix/node_modules/.bin/lobu" DAEMON_CWD="$daemon_cwd" node --input-type=module <<'NODE'
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = process.env.PACKAGE_ROOT;
const publishedEntry = process.env.PUBLISHED_ENTRY;
const daemonCwd = process.env.DAEMON_CWD;
const entry = resolve(packageRoot, 'dist/bin.js');
const token = 'owl_pat_packaged_shell_smoke';
let activeAttempt = null;
let midCommandPidFile = null;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/api/health' && request.method === 'GET') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: 'bad smoke-test authorization' });
      return;
    }
    if (request.url === '/api/workers/poll' && request.method === 'POST') {
      const body = await readJson(request);
      const manifest = body.connector_manifests?.find((item) => item.key === 'os.shell');
      if (
        body.worker_id !== 'headless:package-smoke' ||
        body.platform !== 'headless' ||
        body.capabilities?.['os.shell'] !== true ||
        body.capacity_available !== 1 ||
        manifest?.version !== '0.2.0' ||
        manifest?.runtime?.execution !== 'daemon_builtin'
      ) {
        json(response, 400, { error: 'invalid worker advertisement', body });
        return;
      }
      if (activeAttempt && !activeAttempt.claimed) {
        activeAttempt.claimed = true;
        if (midCommandPidFile) process.stderr.write(`mid-command claimed ${activeAttempt.runId}\n`);
        json(response, 200, {
          run_id: activeAttempt.runId,
          run_type: 'action',
          connector_key: 'os.shell',
          connector_version: '0.2.0',
          connector_manifest_hash: 'package-smoke-manifest',
          execution_backend: 'daemon_builtin',
          action_key: 'run',
          action_input: {
            ...(midCommandPidFile
              ? {
                  command: `trap '' TERM; sleep 30 & child_pid=$!; printf '%s\\n' "$PPID" "$$" "$child_pid" > ${JSON.stringify(midCommandPidFile)}; wait "$child_pid"`,
                }
              : { command: "printf 'lobu-shell-ok\\n'" }),
            cwd: midCommandPidFile ? daemonCwd : process.cwd(),
          },
        });
        return;
      }
      json(response, 200, { next_poll_seconds: 0.05 });
      return;
    }
    if (request.url === '/api/workers/complete-action' && request.method === 'POST') {
      const body = await readJson(request);
      if (!activeAttempt || body.run_id !== activeAttempt.runId) {
        json(response, 409, { error: 'unexpected completion', body });
        return;
      }
      const output = body.action_output;
      if (
        body.worker_id !== 'headless:package-smoke' ||
        body.status !== 'success' ||
        output?.stdout !== 'lobu-shell-ok\n' ||
        output?.stderr !== '' ||
        output?.exit_code !== 0 ||
        output?.success !== true ||
        output?.timed_out !== false
      ) {
        activeAttempt.reject(new Error(`unexpected completion: ${JSON.stringify(body)}`));
      } else {
        activeAttempt.resolve();
      }
      json(response, 200, {});
      return;
    }
    if (request.url === '/api/workers/heartbeat' && request.method === 'POST') {
      json(response, 200, {});
      return;
    }
    json(response, 404, { error: `unexpected route ${request.method} ${request.url}` });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock worker API did not bind TCP');
const apiUrl = `http://127.0.0.1:${address.port}`;

async function runAttempt(attempt, daemonEntry = entry) {
  const runId = 463 + attempt;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolveDone, rejectDone) => {
    resolveCompletion = resolveDone;
    rejectCompletion = rejectDone;
  });
  activeAttempt = {
    runId,
    claimed: false,
    resolve: resolveCompletion,
    reject: rejectCompletion,
  };
  const child = spawn(
    process.execPath,
    [
      daemonEntry,
      'daemon',
      '--api-url', apiUrl,
      '--platform', 'headless',
      '--worker-id', 'headless:package-smoke',
      '--capabilities', 'os.shell',
      ...(daemonEntry === entry ? ['--version', 'package-smoke'] : []),
    ],
    {
      cwd: daemonCwd,
      env: {
        ...process.env,
        WORKER_API_TOKEN: token,
        WORKER_MAX_CONCURRENT_JOBS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const exitResult = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const earlyExit = exitResult.then(({ code, signal }) => {
    throw new Error(`packaged daemon exited before completion (${code ?? signal})\n${logs}`);
  });
  let timeoutHandle;
  const timeout = new Promise((_, rejectTimeout) => {
    timeoutHandle = setTimeout(
      () => rejectTimeout(new Error(`packaged daemon timed out\n${logs}`)),
      15_000,
    );
  });

  try {
    await Promise.race([completion, earlyExit, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  child.kill('SIGTERM');
  const exit = await Promise.race([
    exitResult,
    new Promise((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`packaged daemon shutdown timed out\n${logs}`));
    }, 5_000)),
  ]);
  if (exit.code !== 0) {
    throw new Error(`packaged daemon shutdown failed (${exit.code ?? exit.signal})\n${logs}`);
  }
  process.stdout.write(`packaged queue os.shell attempt ${attempt}: ok\n`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function groupIsAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitUntil(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runMidCommandCrashAttempt() {
  const pidFile = resolve(daemonCwd, 'mid-command-descendant.pid');
  midCommandPidFile = pidFile;
  activeAttempt = { runId: 466, claimed: false, resolve() {}, reject(error) { throw error; } };
  const daemon = spawn(process.execPath, [
    entry, 'daemon', '--api-url', apiUrl, '--platform', 'headless',
    '--worker-id', 'headless:package-smoke', '--capabilities', 'os.shell', '--version', 'package-smoke',
  ], { cwd: daemonCwd, env: { ...process.env, WORKER_API_TOKEN: token, WORKER_MAX_CONCURRENT_JOBS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  daemon.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  daemon.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const daemonExit = new Promise((resolveExit) => daemon.once('exit', (code, signal) => resolveExit({ code, signal })));
  let supervisorPid = 0;
  let shellPid = 0;
  let childPid = 0;
  let groupPid = 0;
  try {
    try {
      await waitUntil(() => {
        if (!isAlive(daemon.pid)) return false;
        let recordedPids;
        try {
          recordedPids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
        } catch {
          return false;
        }
        if (
          recordedPids.length !== 3 ||
          recordedPids.some((pid) => !Number.isInteger(pid) || pid <= 0) ||
          new Set(recordedPids).size !== recordedPids.length ||
          recordedPids.some((pid) => pid === process.pid || pid === daemon.pid)
        ) return false;
        [supervisorPid, shellPid, childPid] = recordedPids;
        groupPid = supervisorPid;
        return isAlive(supervisorPid) && isAlive(shellPid) && isAlive(childPid) && groupIsAlive(groupPid);
      }, 'daemon supervisor, shell target, child, and owned group');
    } catch (error) {
      throw new Error(`${error.message}\n${logs}`);
    }
    daemon.kill('SIGKILL');
    await Promise.race([daemonExit, new Promise((_, reject) => setTimeout(() => reject(new Error(`daemon SIGKILL did not exit\n${logs}`)), 5_000))]);
    await waitUntil(
      () => !isAlive(supervisorPid) && !isAlive(shellPid) && !isAlive(childPid) && !groupIsAlive(groupPid),
      'owned supervisor, shell target, child, and group cleanup after daemon SIGKILL',
    );
    process.stdout.write(`packaged mid-command SIGKILL cleanup: daemon=${daemon.pid} supervisor=${supervisorPid} shell=${shellPid} child=${childPid} group=${groupPid} ok\n`);
  } finally {
    for (const pid of [childPid, shellPid, supervisorPid, daemon.pid]) {
      if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    if (groupPid && groupPid !== process.pid && groupIsAlive(groupPid)) {
      try { process.kill(-groupPid, 'SIGKILL'); } catch {}
    }
    midCommandPidFile = null;
    activeAttempt = null;
  }
}

try {
  await runAttempt(1);
  await runMidCommandCrashAttempt();
  await runAttempt(2);
  await runAttempt(3, publishedEntry);
} finally {
  activeAttempt = null;
  await new Promise((resolveClose) => server.close(resolveClose));
}
NODE
