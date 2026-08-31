import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  releaseSupervisor,
  signalOwnedPosixProcessGroup,
  spawnSupervisedCli,
  terminateChild,
} from '../automation-process.js';

export interface ShellRunOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
  timed_out: boolean;
  duration_ms: number;
}

// The owned process group is cleaned up automatically. Deliberately detached
// new sessions are outside that ownership contract and must be cleaned up by
// their creator; never signal a detached numeric PGID after ownership ends.

const DEFAULT_TIMEOUT_MS = 60_000;
// The requested command budget must leave room inside run_sdk's 180s ceiling
// for 3s TERM grace, up to 5s reaping, up to 15s terminal delivery, and
// bounded network/server grace.
const MAX_TIMEOUT_MS = 150_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_DRAIN_GRACE_MS = 2_000;
const TRUNCATED_MARKER = '\n... (output truncated)';
function appendCapped(current: string, chunk: string): string {
  if (current.endsWith(TRUNCATED_MARKER)) return current;
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= MAX_OUTPUT_BYTES) return next;
  return Buffer.from(next, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + TRUNCATED_MARKER;
}

function readTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return Number(value);
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
  };
  return env;
}

export async function runShellBuiltin(
  input: Record<string, unknown>,
  shutdownSignal?: AbortSignal
): Promise<ShellRunOutput> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) throw new Error('command is required');
  if (command.length > 20_000) throw new Error('command must contain at most 20000 characters');

  const cwdValue = input.cwd;
  const cwd = cwdValue === undefined ? homedir() : String(cwdValue);
  if (!isAbsolute(cwd) || !existsSync(cwd)) {
    throw new Error(`cwd must be an existing absolute path (got '${cwd}')`);
  }
  const timeoutMs = readTimeout(input.timeout_ms);
  const stdin = input.stdin;
  if (stdin !== undefined && typeof stdin !== 'string') throw new Error('stdin must be a string');
  if (typeof stdin === 'string' && stdin.length > 1_000_000) {
    throw new Error('stdin must contain at most 1000000 characters');
  }

  const startedAt = Date.now();
  return await new Promise<ShellRunOutput>((resolve) => {
    const supervised = spawnSupervisedCli(
      'bash', ['--noprofile', '--norc', '-c', command], shellEnvironment(), { stdin: 'pipe', cwd },
    );
    const child = supervised.supervisor;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let finishing = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const waitForClose = (stream: NodeJS.ReadableStream | null | undefined): Promise<void> => {
      if (!stream || (stream as NodeJS.ReadableStream & { destroyed?: boolean }).destroyed) {
        return Promise.resolve();
      }
      return new Promise((resolve) => stream.once('close', resolve));
    };
    const stdoutClosed = waitForClose(child.stdout);
    const stderrClosed = waitForClose(child.stderr);

    const killOwnedProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid != null) {
          if (signalOwnedPosixProcessGroup(child, signal)) return;
        }
      } catch {}
      try { child.kill(signal); } catch {}
    };

    const abortHandler = () => {
      if (!settled) void terminateChild(child).finally(() => finishAfterOutputDrain(child.exitCode ?? -1));
    };
    // Let the finish closure initialize before handling an already-aborted
    // signal; this path is common during daemon shutdown.
    if (shutdownSignal?.aborted) queueMicrotask(abortHandler);
    else shutdownSignal?.addEventListener('abort', abortHandler, { once: true });

    // Synchronous by construction: the only caller drains and destroys both
    // pipes before calling this, so there is nothing left to await here.
    const finish = (exitCode: number): void => {
      if (settled || finishing) return;
      finishing = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      shutdownSignal?.removeEventListener('abort', abortHandler);
      settled = true;
      resolve({
        stdout,
        stderr,
        exit_code: exitCode,
        success: !timedOut && exitCode === 0,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    };

    const finishAfterOutputDrain = async (exitCode: number): Promise<void> => {
      await Promise.race([
        Promise.all([stdoutClosed, stderrClosed]),
        new Promise((resolve) => setTimeout(resolve, OUTPUT_DRAIN_GRACE_MS).unref()),
      ]);
      if (!settled) child.stdout?.destroy();
      if (!settled) child.stderr?.destroy();
      finish(exitCode);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stderr = appendCapped(stderr, `stdin error: ${error.message}\n`);
    });
    child.stdin?.end(stdin);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminateChild(child).finally(() => finishAfterOutputDrain(child.exitCode ?? -1));
    }, timeoutMs);

    supervised.targetExit.then((target) => {
      if (process.platform !== 'win32') killOwnedProcessGroup('SIGKILL');
      else void terminateChild(child);
      void releaseSupervisor(child).finally(() => finishAfterOutputDrain(target.exitCode ?? -1));
    });
    child.on('error', (error) => {
      stderr = appendCapped(stderr, `spawn error: ${error.message}`);
      void finishAfterOutputDrain(-1);
    });
  });
}
