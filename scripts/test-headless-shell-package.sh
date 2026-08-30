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
trap 'rm -rf "$smoke_dir"' EXIT

npm pack "$package_root" --pack-destination "$smoke_dir" --silent >/dev/null
archives=("$smoke_dir"/*.tgz)
test "${#archives[@]}" -eq 1 || {
  echo "expected one connector-worker tarball, found ${#archives[@]}" >&2
  exit 1
}
tar -xzf "${archives[0]}" -C "$smoke_dir"

PACKAGE_ROOT="$smoke_dir/package" node --input-type=module <<'NODE'
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

# The full daemon has ordinary package dependencies. Reuse the repository's
# already-installed dependency graph without copying it into the artifact; ESM
# resolution still starts from the extracted package and the direct check above
# has already proven the built-in itself is dependency-isolated.
ln -s "$repo_root/node_modules" "$smoke_dir/node_modules"

PACKAGE_ROOT="$smoke_dir/package" node --input-type=module <<'NODE'
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const packageRoot = process.env.PACKAGE_ROOT;
const entry = resolve(packageRoot, 'dist/bin.js');
const token = 'owl_pat_packaged_shell_smoke';
let activeAttempt = null;

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
        json(response, 200, {
          run_id: activeAttempt.runId,
          run_type: 'action',
          connector_key: 'os.shell',
          connector_version: '0.2.0',
          connector_manifest_hash: 'package-smoke-manifest',
          execution_backend: 'daemon_builtin',
          action_key: 'run',
          action_input: {
            command: "printf 'lobu-shell-ok\\n'",
            cwd: process.cwd(),
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

async function runAttempt(attempt) {
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
      entry,
      'daemon',
      '--api-url', apiUrl,
      '--platform', 'headless',
      '--worker-id', 'headless:package-smoke',
      '--capabilities', 'os.shell',
      '--version', 'package-smoke',
    ],
    {
      cwd: packageRoot,
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
  const exit = await exitResult;
  if (exit.code !== 0) {
    throw new Error(`packaged daemon shutdown failed (${exit.code ?? exit.signal})\n${logs}`);
  }
  process.stdout.write(`packaged queue os.shell attempt ${attempt}: ok\n`);
}

try {
  await runAttempt(1);
  await runAttempt(2);
} finally {
  activeAttempt = null;
  await new Promise((resolveClose) => server.close(resolveClose));
}
NODE
