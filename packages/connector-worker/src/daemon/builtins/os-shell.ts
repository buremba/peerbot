import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

export interface ShellRunOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
  timed_out: boolean;
  duration_ms: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TRUNCATED_MARKER = '\n... (output truncated)';
// Keep the outer process group alive through the grace period so its numeric
// pgid cannot be recycled before SIGKILL. The inner shell starts cleanly and
// still receives the command's normal signals.
const SHELL_GROUP_ANCHOR = `trap 'sleep 4' TERM
bash --noprofile --norc -lc "$1"
status=$?
exit "$status"`;

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
    const child = spawn('bash', ['-c', SHELL_GROUP_ANCHOR, 'lobu-os-shell', command], {
      cwd,
      env: shellEnvironment(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const killOwnedProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid != null) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // The process group may have already exited or the platform may not
        // support negative process ids. Fall back to the direct child.
      }
      try {
        child.kill(signal);
      } catch {
        // Exit raced cleanup; close/error still owns settlement.
      }
    };

    const abortHandler = () => {
      killOwnedProcessGroup('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        killOwnedProcessGroup('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode ?? -1);
      }, TERMINATION_GRACE_MS);
    };
    if (shutdownSignal?.aborted) abortHandler();
    else shutdownSignal?.addEventListener('abort', abortHandler, { once: true });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      shutdownSignal?.removeEventListener('abort', abortHandler);
      resolve({
        stdout,
        stderr,
        exit_code: exitCode,
        success: !timedOut && exitCode === 0,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stderr = appendCapped(stderr, `stdin error: ${error.message}\n`);
    });
    child.stdin.end(stdin);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killOwnedProcessGroup('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        killOwnedProcessGroup('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode ?? -1);
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);

    child.on('close', (code, signal) => {
      finish(code ?? (signal ? -1 : 0));
    });
    child.on('error', (error) => {
      stderr = appendCapped(stderr, `spawn error: ${error.message}`);
      finish(-1);
    });
  });
}
