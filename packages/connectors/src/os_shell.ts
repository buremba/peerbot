/**
 * os.shell - run shell commands on the host device.
 *
 * Device-bound connector served by the connector-worker daemon on headless
 * devices (servers, VMs, k8s pods). Executes through `bash --noprofile --norc -c` and returns
 * structured stdout/stderr/exit_code - the same contract as the macOS
 * os.shell manifest, but for boxes without a UI. Commands run in the device's
 * real environment (host PATH, files), so the action is approval-gated. The
 * timeout bounds this call and cleans up its process group; it is not sandbox
 * containment, and deliberately daemonized/session-detached work may outlive it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  ConnectorRuntime,
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
} from '@lobu/connector-sdk';

interface RunInput {
  command?: string;
  cwd?: string;
  timeout_ms?: number;
  stdin?: string;
}

interface RunOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
  timed_out: boolean;
  duration_ms: number;
}

// Keep the requested command budget truthful: run_sdk's 180s outer ceiling
// must also cover 3s TERM grace, up to 5s reaping, up to 15s terminal
// delivery, and bounded network/server grace.
const MAX_TIMEOUT_MS = 150000;
const DEFAULT_TIMEOUT_MS = 60000;
const SIGTERM_GRACE_MS = 3000;
// The outer shell remains the live process-group owner until Node's grace
// timer fires, so its numeric pgid cannot be recycled before SIGKILL. The
// inner login shell and command still receive SIGTERM normally.
//
// The trap must outlive the grace timer, so derive it rather than restating
// it: a hardcoded sleep silently reopens the recycle window the moment
// SIGTERM_GRACE_MS is raised past it, and nothing would fail to say so.
const SHELL_GROUP_ANCHOR = `trap 'sleep ${(SIGTERM_GRACE_MS + 1000) / 1000}' TERM
bash --noprofile --norc -c "$1"
status=$?
exit "$status"`;
// Cap captured output so a chatty command cannot balloon daemon memory.
// Streams keep draining (the child must not block on a full pipe), but
// anything past the cap is dropped with a truncation marker.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TRUNCATED_MARKER = '\n... (output truncated)';

function appendCapped(target: string, chunk: string, truncated: boolean): string {
  if (truncated) return target;
  const next = target + chunk;
  if (next.length > MAX_OUTPUT_BYTES) {
    return next.slice(0, MAX_OUTPUT_BYTES) + TRUNCATED_MARKER;
  }
  return next;
}

function runShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs: number; stdin?: string }
): Promise<RunOutput> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', SHELL_GROUP_ANCHOR, 'lobu-os-shell', command], {
      cwd: opts.cwd || undefined,
      env: { ...process.env, LC_ALL: 'C' },
      // Give the command its own process group. Killing only the `bash`
      // process leaves same-group background work alive with stdout/stderr
      // open. A command can deliberately escape with setsid/daemonization;
      // this timeout is bounded cleanup, not an OS containment boundary.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const killProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid != null) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // The group may already be gone, or the host may not support negative
        // process ids. `child.kill` is the safe best-effort fallback.
      }
      try {
        child.kill(signal);
      } catch {
        // Exit raced the timeout. `close` still owns final settlement.
      }
    };

    const finish = (output: RunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(output);
    };

    // A command is allowed to exit without reading stdin. Node reports that
    // normal pipe race as EPIPE; without an error listener it becomes an
    // uncaught exception and takes down the long-lived connector daemon.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        stderr = appendCapped(
          stderr,
          `${stderr ? '\n' : ''}stdin error: ${err.message}`,
          stderrTruncated
        );
        if (stderr.includes(TRUNCATED_MARKER)) stderrTruncated = true;
      }
    });
    child.stdin.end(opts.stdin);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, stdoutTruncated);
      if (stdout.includes(TRUNCATED_MARKER)) stdoutTruncated = true;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, stderrTruncated);
      if (stderr.includes(TRUNCATED_MARKER)) stderrTruncated = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        killProcessGroup('SIGKILL');
        // A setsid/daemonized descendant can escape the owned group while
        // retaining inherited pipe descriptors. Destroy our pipe ends and
        // settle explicitly so such a process cannot extend the caller's
        // timeout. The escaped process is outside this connector's cleanup
        // contract and may continue running.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish({
          stdout,
          stderr,
          exit_code: child.exitCode ?? -1,
          success: false,
          timed_out: true,
          duration_ms: Date.now() - started,
        });
      }, SIGTERM_GRACE_MS);
    }, opts.timeoutMs);

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      const exitCode = code ?? (signal ? -1 : 0);
      finish({
        stdout,
        stderr,
        exit_code: exitCode,
        success: !timedOut && exitCode === 0,
        timed_out: timedOut,
        duration_ms: durationMs,
      });
    });

    child.on('error', (err) => {
      finish({
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}spawn error: ${err.message}`,
        exit_code: -1,
        success: false,
        timed_out: false,
        duration_ms: Date.now() - started,
      });
    });
  });
}

export default class OsShellConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'os.shell',
    name: 'Shell',
    description:
      'Run shell commands on the host device. Executes via `bash --noprofile --norc -c` and returns structured stdout/stderr/exit_code. Same trust tier as the macOS shell connector - commands run in the device\'s real environment (host PATH, files), so gate with approval.',
    version: '0.1.0',
    requiredCapability: 'os.shell',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
    actions: {
      run: {
        key: 'run',
        kind: 'write',
        name: 'Run command',
        description:
          'Run a shell command on the device and return stdout, stderr, and exit_code. Executes through `bash --noprofile --norc -c`, so pipes, redirects, and && chains work, but shell profile/rc files are NOT loaded - use absolute paths rather than relying on aliases. Prefer one focused command per call.',
        requiresApproval: true,
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              minLength: 1,
              maxLength: 20000,
              description: 'Shell command to execute. Runs via `bash --noprofile --norc -c`, so pipes, redirects, and && chains work, but no profile or rc file is loaded. Keep commands short and targeted.',
            },
            cwd: {
              type: 'string',
              description: 'Absolute working directory. Defaults to the device home. Must exist.',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 150000,
              default: 60000,
              description:
                'Wall-clock budget in milliseconds. On timeout the owned process group gets SIGTERM (3s grace) then SIGKILL. Session-detached or daemonized commands may outlive the call; this is not sandbox containment.',
            },
            stdin: {
              type: 'string',
              maxLength: 1000000,
              description: 'Optional string piped to the command\'s stdin.',
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            stdout: { type: 'string' },
            stderr: { type: 'string' },
            exit_code: { type: 'integer' },
            success: { type: 'boolean' },
            timed_out: { type: 'boolean' },
            duration_ms: { type: 'integer' },
          },
        },
      },
    },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (ctx.actionKey !== 'run') {
      return { success: false, error: `Unknown action '${ctx.actionKey}'` };
    }
    const input = ctx.input as RunInput;
    const command = input.command?.trim();
    if (!command) {
      return { success: false, error: 'command is required' };
    }
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      return {
        success: false,
        error: `timeout_ms must be an integer between 100 and ${MAX_TIMEOUT_MS}`,
      };
    }
    // cwd must be an existing absolute path (the declared contract); default
    // to the device home. Reject rather than let bash guess at a relative cwd.
    let cwd: string | undefined;
    if (input.cwd) {
      if (!isAbsolute(input.cwd) || !existsSync(input.cwd)) {
        return {
          success: false,
          error: `cwd must be an existing absolute path (got '${input.cwd}')`,
        };
      }
      cwd = input.cwd;
    } else {
      cwd = homedir();
    }
    const output = await runShellCommand(command, {
      cwd,
      timeoutMs,
      stdin: input.stdin,
    });
    return { success: output.success, output: { ...output } };
  }
}
