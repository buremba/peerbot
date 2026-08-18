/**
 * os.shell - run shell commands on the host device.
 *
 * Device-bound connector served by the connector-worker daemon on headless
 * devices (servers, VMs, k8s pods). Executes through `bash -lc` and returns
 * structured stdout/stderr/exit_code - the same contract as the macOS
 * os.shell manifest, but for boxes without a UI. Commands run in the device's
 * real environment (host PATH, files), so the action is approval-gated.
 */

import { spawn } from 'node:child_process';
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

const MAX_TIMEOUT_MS = 300000;
const DEFAULT_TIMEOUT_MS = 60000;
const SIGTERM_GRACE_MS = 3000;

function runShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs: number; stdin?: string }
): Promise<RunOutput> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: opts.cwd || undefined,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, SIGTERM_GRACE_MS);
    }, opts.timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const exitCode = code ?? (signal ? -1 : 0);
      resolve({
        stdout,
        stderr,
        exit_code: exitCode,
        success: !timedOut && exitCode === 0,
        timed_out: timedOut,
        duration_ms: durationMs,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
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
      'Run shell commands on the host device. Executes via `bash -lc` and returns structured stdout/stderr/exit_code. Same trust tier as the macOS shell connector - commands run in the device\'s real environment (host PATH, files), so gate with approval.',
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
          'Run a shell command on the device and return stdout, stderr, and exit_code. Executes through `bash -lc`, so pipes, redirects, and && chains work. Prefer one focused command per call.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              minLength: 1,
              maxLength: 20000,
              description: 'Shell command to execute. Runs via `bash -lc`, so pipes, redirects, and && chains work. Keep commands short and targeted.',
            },
            cwd: {
              type: 'string',
              description: 'Absolute working directory. Defaults to the device home. Must exist.',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 300000,
              default: 60000,
              description: 'Wall-clock budget in milliseconds. On timeout the process gets SIGTERM (3s grace) then SIGKILL.',
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

  async sync(): Promise<{ events: []; checkpoint: null }> {
    // No feeds - this connector only serves action runs.
    return { events: [], checkpoint: null };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (ctx.actionKey !== 'run') {
      return { success: false, error: `Unknown action '${ctx.actionKey}'` };
    }
    const input = ctx.input as RunInput;
    const command = input.command?.trim();
    if (!command) {
      return { success: false, error: 'command is required' };
    }
    const timeoutMs = Math.min(
      typeof input.timeout_ms === 'number' ? input.timeout_ms : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const output = await runShellCommand(command, {
      cwd: input.cwd,
      timeoutMs,
      stdin: input.stdin,
    });
    return { success: output.success, output: { ...output } };
  }
}